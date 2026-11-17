/**
 * A tiny keyword-based stand-in for the real NL→query engine, so the UI can be explored end to end.
 * The real backend uses an LLM with schema context; none of this logic ships to production.
 */
import type {
  Answer,
  Clarification,
  Column,
  Confirmation,
  GeneratedQuery,
  QueryError,
  SourceRef,
  TableResult,
} from '@/api/types';
import { formatCompact, formatCurrency, formatCurrencyCompact, formatNumber } from '@/lib/format';
import { sources } from './data';

export interface PlanContext {
  question: string;
  allowedSourceIds: Set<string>;
  selectedSourceIds: string[];
  clarificationOptionId?: string;
  confirmed?: boolean;
}

export type AnswerDraft = Omit<Answer, 'queryId' | 'freshness' | 'question' | 'rowLimit'>;

export type Plan =
  | { kind: 'clarify'; clarification: Clarification; sources: SourceRef[] }
  | { kind: 'confirm'; confirmation: Confirmation; sources: SourceRef[] }
  | { kind: 'error'; error: QueryError; sources: SourceRef[] }
  | { kind: 'answer'; draft: AnswerDraft; sources: SourceRef[] };

export function sourceRef(id: string): SourceRef {
  const source = sources.find((item) => item.id === id);
  if (!source) throw new Error(`Unknown source ${id}`);
  return { id: source.id, name: source.name, type: source.type };
}

function monthName(offset: number) {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  return date;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

/* ───────────── Answer builders ───────────── */

function salesByRegion(net: boolean): AnswerDraft {
  const factor = net ? 0.91 : 1;
  const raw: [string, number, number][] = [
    ['North America', 1_284_500, 3_420],
    ['Europe', 968_200, 2_610],
    ['Asia Pacific', 742_900, 2_050],
    ['Latin America', 311_400, 980],
    ['Middle East & Africa', 188_700, 540],
  ];
  const rows = raw.map(([region, revenue, orders]) => {
    const value = Math.round(revenue * factor);
    return { region, revenue: value, orders, avg_order_value: Math.round((value / orders) * 100) / 100 };
  });
  const total = rows.reduce((sum, row) => sum + row.revenue, 0);
  const orders = rows.reduce((sum, row) => sum + row.orders, 0);
  const start = monthName(-1);
  const end = monthName(0);
  const monthLabel = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const label = net ? 'Net revenue' : 'Revenue';
  const columns: Column[] = [
    { key: 'region', label: 'Region', type: 'string' },
    { key: 'revenue', label, type: 'currency', currency: 'USD' },
    { key: 'orders', label: 'Orders', type: 'number' },
    { key: 'avg_order_value', label: 'Avg. order value', type: 'currency', currency: 'USD' },
  ];
  const sales = sourceRef('sales-db');
  return {
    summary: `${label} in ${monthLabel} was ${formatCurrency(total)} across ${rows.length} regions. North America led with ${formatCurrency(rows[0].revenue)} (${Math.round((rows[0].revenue / total) * 100)}%), followed by Europe.`,
    highlights: [
      { label: `Total ${label.toLowerCase()}`, value: formatCurrencyCompact(total) },
      { label: 'Orders', value: formatNumber(orders) },
      { label: 'Top region', value: 'North America' },
    ],
    sources: [sales],
    explanation: `I used the orders table in the Sales Database, added up order totals for ${monthLabel}${net ? ', subtracted refunds,' : ''} excluded cancelled orders, and grouped the results by region.`,
    generatedQueries: [
      {
        source: sales,
        language: 'sql',
        text: `SELECT r.region_name                 AS region,
       SUM(o.total_amount${net ? ' - COALESCE(o.refunded_amount, 0)' : ''}) AS revenue,
       COUNT(*)                      AS orders,
       AVG(o.total_amount)           AS avg_order_value
FROM public.orders o
JOIN public.regions r ON r.region_id = o.region_id
WHERE o.order_date >= DATE '${isoDate(start)}'
  AND o.order_date <  DATE '${isoDate(end)}'
  AND o.status <> 'cancelled'
GROUP BY r.region_name
ORDER BY revenue DESC
LIMIT 500;`,
      },
    ],
    result: { kind: 'table', columns, rows, totalRows: rows.length },
    chart: { type: 'bar', x: 'region', series: ['revenue'] },
    followUps: ['How does that compare with the month before?', 'Which products sold best in North America?', 'Show monthly revenue for this year compared with last year'],
  };
}

function monthlyTrend(): AnswerDraft {
  const year = new Date().getFullYear();
  const months = Math.max(1, new Date().getMonth());
  const base2025 = [612, 588, 701, 664, 720, 748, 702, 690, 756, 802, 840, 910];
  const base2026 = [655, 640, 772, 731, 802, 815, 790, 768, 851, 889, 0, 0];
  const rows = Array.from({ length: months }, (_, index) => ({
    month: new Date(year, index, 1).toLocaleDateString('en-US', { month: 'short' }),
    this_year: base2026[index] * 1000 + 412,
    last_year: base2025[index] * 1000 + 233,
  }));
  const totalThis = rows.reduce((sum, row) => sum + row.this_year, 0);
  const totalLast = rows.reduce((sum, row) => sum + row.last_year, 0);
  const growth = (totalThis - totalLast) / totalLast;
  const sales = sourceRef('sales-db');
  return {
    summary: `Revenue so far this year is ${formatCurrency(totalThis)}, ${Math.round(growth * 100)}% higher than the same months last year (${formatCurrency(totalLast)}). Every month has been ahead of last year.`,
    highlights: [
      { label: `${year} to date`, value: formatCurrencyCompact(totalThis) },
      { label: `${year - 1} same period`, value: formatCurrencyCompact(totalLast) },
      { label: 'Growth', value: `+${Math.round(growth * 100)}%` },
    ],
    sources: [sales],
    explanation: 'I summed order totals per calendar month for this year and last year from the Sales Database, excluding cancelled orders.',
    generatedQueries: [
      {
        source: sales,
        language: 'sql',
        text: `SELECT TO_CHAR(order_date, 'Mon') AS month,
       SUM(total_amount) FILTER (WHERE EXTRACT(YEAR FROM order_date) = ${year})     AS this_year,
       SUM(total_amount) FILTER (WHERE EXTRACT(YEAR FROM order_date) = ${year - 1}) AS last_year
FROM public.orders
WHERE status <> 'cancelled'
  AND EXTRACT(MONTH FROM order_date) <= ${months}
GROUP BY EXTRACT(MONTH FROM order_date), TO_CHAR(order_date, 'Mon')
ORDER BY EXTRACT(MONTH FROM order_date);`,
      },
    ],
    result: {
      kind: 'table',
      columns: [
        { key: 'month', label: 'Month', type: 'string' },
        { key: 'this_year', label: String(year), type: 'currency', currency: 'USD' },
        { key: 'last_year', label: String(year - 1), type: 'currency', currency: 'USD' },
      ],
      rows,
      totalRows: rows.length,
    },
    chart: { type: 'line', x: 'month', series: ['this_year', 'last_year'] },
    followUps: ['Which region grew the fastest?', 'What were total sales by region last month?'],
  };
}

function topProducts(): AnswerDraft {
  const rows = [
    ['Pro Plan (annual)', 1_840, 1_104_000],
    ['Analytics Add-on', 2_310, 692_400],
    ['Team Seats (10 pack)', 1_120, 548_800],
    ['Onboarding Package', 640, 384_000],
    ['Premium Support', 980, 352_800],
    ['API Access Tier 2', 410, 287_000],
    ['Data Export Module', 760, 228_000],
    ['Starter Plan (annual)', 2_950, 206_500],
  ].map(([product, units, revenue]) => ({ product: product as string, units: units as number, revenue: revenue as number }));
  const sales = sourceRef('sales-db');
  return {
    summary: `Your top product by revenue over the last 90 days is the Pro Plan (annual) at ${formatCurrency(rows[0].revenue)}. The top 8 products brought in ${formatCurrency(rows.reduce((s, r) => s + r.revenue, 0))}.`,
    highlights: [
      { label: 'Top product', value: 'Pro Plan (annual)' },
      { label: 'Most units sold', value: 'Starter Plan (annual)' },
    ],
    sources: [sales],
    explanation: 'I joined order items to products in the Sales Database for the last 90 days and ranked products by revenue.',
    generatedQueries: [
      {
        source: sales,
        language: 'sql',
        text: `SELECT p.product_name AS product, SUM(i.quantity) AS units, SUM(i.quantity * i.unit_price) AS revenue
FROM public.order_items i
JOIN public.products p ON p.product_id = i.product_id
JOIN public.orders o   ON o.order_id = i.order_id
WHERE o.order_date >= CURRENT_DATE - INTERVAL '90 days' AND o.status <> 'cancelled'
GROUP BY p.product_name
ORDER BY revenue DESC
LIMIT 8;`,
      },
    ],
    result: {
      kind: 'table',
      columns: [
        { key: 'product', label: 'Product', type: 'string' },
        { key: 'units', label: 'Units', type: 'number' },
        { key: 'revenue', label: 'Revenue', type: 'currency', currency: 'USD' },
      ],
      rows,
      totalRows: rows.length,
    },
    chart: { type: 'bar', x: 'product', series: ['revenue'] },
    followUps: ['Which region buys the most Analytics Add-ons?', 'Show monthly revenue for this year compared with last year'],
  };
}

function delayedOrders(): AnswerDraft {
  const companies = ['Acme Corp', 'Globex', 'Initech', 'Umbrella Health', 'Stark Logistics', 'Wayne Retail'];
  const carriers = ['DHL', 'FedEx', 'UPS', 'DHL', 'Maersk', 'FedEx'];
  const documents = companies.map((company, index) => ({
    orderId: `ORD-${48210 + index * 37}`,
    status: 'shipped',
    customer: { name: company, email: null, tier: index % 2 === 0 ? 'Enterprise' : 'Growth' },
    items: [
      { sku: 'PRO-ANNUAL', qty: 1 + (index % 3) },
      { sku: 'ADDON-ANALYTICS', qty: 1 },
    ],
    shipping: {
      carrier: carriers[index],
      status: 'delayed',
      eta: new Date(Date.now() + (index + 1) * 86_400_000).toISOString(),
      delayReason: index % 2 === 0 ? 'Customs inspection' : 'Weather',
    },
    createdAt: new Date(Date.now() - (index + 3) * 86_400_000).toISOString(),
  }));
  const events = sourceRef('order-events');
  return {
    summary: `${documents.length} orders are currently delayed. The most common causes are customs inspections and weather. Acme Corp's order ${documents[0].orderId} is expected tomorrow.`,
    highlights: [
      { label: 'Delayed orders', value: String(documents.length) },
      { label: 'Most affected carrier', value: 'DHL / FedEx' },
    ],
    sources: [events],
    explanation: 'I searched the Order Events collection for orders whose shipping status is “delayed”, newest first.',
    generatedQueries: [
      {
        source: events,
        language: 'mongodb',
        text: `db.orders.aggregate([
  { $match: { "shipping.status": "delayed" } },
  { $sort: { createdAt: -1 } },
  { $limit: 500 },
  { $project: { orderId: 1, status: 1, customer: 1, items: 1, shipping: 1, createdAt: 1 } }
])`,
      },
    ],
    result: { kind: 'documents', documents, totalRows: documents.length, maskedPaths: ['customer.email'] },
    followUps: ['Which carrier has the most delays this month?', 'Show the latest orders for Acme Corp'],
  };
}

function liveStats(): AnswerDraft {
  const cache = sourceRef('live-cache');
  return {
    summary: '1,342 people are using the app right now — most of them in North America. The new checkout is rolled out to 25% of users.',
    highlights: [
      { label: 'Active right now', value: '1,342' },
      { label: 'Flags turned on', value: '2 of 3' },
    ],
    sources: [cache],
    explanation: 'I read the live counters and feature-flag keys from the Live Sessions Redis database. These values change every few seconds.',
    generatedQueries: [
      {
        source: cache,
        language: 'redis',
        text: 'GET stats:active_users\nHGETALL stats:active_users:by_region\nSCAN 0 MATCH flags:* COUNT 100\nHGETALL flags:checkout_v2\nZREVRANGE leaderboard:top_accounts 0 4 WITHSCORES',
      },
    ],
    result: {
      kind: 'keyvalue',
      totalRows: 5,
      entries: [
        { key: 'stats:active_users', type: 'string', value: '1342', ttlSeconds: 30 },
        {
          key: 'stats:active_users:by_region',
          type: 'hash',
          value: { 'North America': '611', Europe: '402', 'Asia Pacific': '248', 'Latin America': '81' },
          ttlSeconds: 30,
        },
        { key: 'flags:checkout_v2', type: 'hash', value: { enabled: 'true', rollout: '25%', owner: 'payments-team' }, ttlSeconds: null },
        { key: 'flags:dark_mode_default', type: 'hash', value: { enabled: 'false', rollout: '0%', owner: 'design-team' }, ttlSeconds: null },
        {
          key: 'leaderboard:top_accounts',
          type: 'zset',
          value: [
            { member: 'Acme Corp', score: 18_420 },
            { member: 'Globex', score: 15_310 },
            { member: 'Initech', score: 9_870 },
            { member: 'Umbrella Health', score: 7_455 },
            { member: 'Stark Logistics', score: 6_120 },
          ],
          ttlSeconds: 3600,
        },
      ],
    },
    followUps: ['Which feature flags are turned on?', 'Which orders are delayed in shipping?'],
  };
}

function renewals(): AnswerDraft {
  const companies: [string, string, number, string][] = [
    ['Acme Corp', 'Enterprise', 42_000, 'Good'],
    ['Globex', 'Enterprise', 38_500, 'At risk'],
    ['Initech', 'Growth', 12_400, 'Good'],
    ['Umbrella Health', 'Enterprise', 29_900, 'Good'],
    ['Stark Logistics', 'Growth', 9_800, 'Critical'],
    ['Wayne Retail', 'Growth', 14_200, 'At risk'],
    ['Hooli', 'Starter', 1_900, 'Good'],
    ['Vandelay Imports', 'Growth', 11_600, 'Good'],
  ];
  const rows = companies.map(([company, plan, mrr, health], index) => ({
    company,
    plan,
    mrr,
    renewal_date: isoDate(new Date(Date.now() + (index * 3 + 2) * 86_400_000)),
    health,
    contact_email: null,
  }));
  const total = rows.reduce((sum, row) => sum + row.mrr, 0);
  const crm = sourceRef('crm');
  return {
    summary: `${rows.length} customers renew in the next 30 days, worth ${formatCurrency(total)} in monthly recurring revenue. Globex, Wayne Retail and Stark Logistics are flagged at risk — consider reaching out first.`,
    highlights: [
      { label: 'Renewing accounts', value: String(rows.length) },
      { label: 'MRR up for renewal', value: formatCurrencyCompact(total) },
      { label: 'At risk or critical', value: '3' },
    ],
    sources: [crm],
    explanation: 'I looked up accounts in the Customer CRM whose renewal date falls in the next 30 days, soonest first. Contact emails are hidden by policy.',
    generatedQueries: [
      {
        source: crm,
        language: 'sql',
        text: `SELECT a.company, a.plan, a.mrr, a.renewal_date, a.health, c.email AS contact_email
FROM crm.accounts a
LEFT JOIN crm.contacts c ON c.company = a.company AND c.is_primary = 1
WHERE a.renewal_date BETWEEN CURDATE() AND CURDATE() + INTERVAL 30 DAY
ORDER BY a.renewal_date
LIMIT 500;`,
      },
    ],
    result: {
      kind: 'table',
      columns: [
        { key: 'company', label: 'Company', type: 'string' },
        { key: 'plan', label: 'Plan', type: 'string' },
        { key: 'mrr', label: 'MRR', type: 'currency', currency: 'USD' },
        { key: 'renewal_date', label: 'Renews on', type: 'date' },
        { key: 'health', label: 'Health', type: 'string' },
        { key: 'contact_email', label: 'Contact email', type: 'string', masked: true },
      ],
      rows,
      totalRows: rows.length,
    },
    followUps: ['Why is Globex at risk?', 'List our enterprise accounts by MRR'],
  };
}

function transactionsByYear(): AnswerDraft {
  const rows = [2019, 2020, 2021, 2022, 2023, 2024, 2025].map((year, index) => ({
    year: String(year),
    transactions: [612_400, 704_900, 812_300, 905_100, 1_002_800, 1_118_600, 1_248_330][index],
    revenue: [41.2, 47.9, 55.1, 61.8, 69.4, 77.0, 86.3][index] * 1_000_000,
  }));
  const warehouse = sourceRef('warehouse');
  return {
    summary: `We processed ${formatNumber(rows[rows.length - 1].transactions)} transactions in 2025, roughly double 2019. Transaction volume has grown every year.`,
    highlights: [
      { label: '2025 transactions', value: formatCompact(rows[rows.length - 1].transactions) },
      { label: '2025 revenue', value: formatCurrencyCompact(rows[rows.length - 1].revenue) },
    ],
    sources: [warehouse],
    explanation: 'I counted transactions per calendar year in the Analytics Warehouse.',
    generatedQueries: [
      {
        source: warehouse,
        language: 'sql',
        text: `SELECT YEAR(TRANSACTION_DATE) AS year, COUNT(*) AS transactions, SUM(AMOUNT_USD) AS revenue
FROM ANALYTICS.CORE.TRANSACTIONS
WHERE TRANSACTION_DATE >= '2019-01-01' AND TRANSACTION_DATE < '2026-01-01'
GROUP BY 1
ORDER BY 1;`,
      },
    ],
    result: {
      kind: 'table',
      columns: [
        { key: 'year', label: 'Year', type: 'string' },
        { key: 'transactions', label: 'Transactions', type: 'number' },
        { key: 'revenue', label: 'Revenue', type: 'currency', currency: 'USD' },
      ],
      rows,
      totalRows: rows.length,
    },
    chart: { type: 'bar', x: 'year', series: ['transactions'] },
    followUps: ['List all transactions from the partner channel', 'What is the average customer lifetime value?'],
  };
}

function transactionList(): AnswerDraft {
  const channels = ['web', 'mobile', 'partner', 'sales'];
  const rows = Array.from({ length: 500 }, (_, index) => ({
    transaction_id: `TX-${(9_870_000 - index * 13).toString(36).toUpperCase()}`,
    date: isoDate(new Date(Date.now() - index * 3_600_000 * 7)),
    customer_id: 100_000 + ((index * 7919) % 50_000),
    amount: Math.round(((index * 37) % 2000) + 19.99 * ((index % 7) + 1)) + 0.99,
    channel: channels[index % 4],
    card_last4: null,
  }));
  const warehouse = sourceRef('warehouse');
  return {
    summary: 'Here are the most recent 500 of 1,248,330 transactions. That is too many to show at once — add a filter like a date range, customer or amount to narrow it down, or export if you need the full list.',
    highlights: [{ label: 'Matching transactions', value: '1,248,330' }],
    sources: [warehouse],
    explanation: 'I listed transactions from the Analytics Warehouse, newest first, limited to 500 rows for display. Card digits are hidden by policy.',
    generatedQueries: [
      {
        source: warehouse,
        language: 'sql',
        text: `SELECT TRANSACTION_ID, TRANSACTION_DATE AS date, CUSTOMER_ID, AMOUNT_USD AS amount, CHANNEL, CARD_LAST4
FROM ANALYTICS.CORE.TRANSACTIONS
ORDER BY TRANSACTION_DATE DESC
LIMIT 500;`,
      },
    ],
    result: {
      kind: 'table',
      columns: [
        { key: 'transaction_id', label: 'Transaction', type: 'string' },
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'customer_id', label: 'Customer ID', type: 'string' },
        { key: 'amount', label: 'Amount', type: 'currency', currency: 'USD' },
        { key: 'channel', label: 'Channel', type: 'string' },
        { key: 'card_last4', label: 'Card', type: 'string', masked: true },
      ],
      rows,
      totalRows: 1_248_330,
    },
    followUps: ['How many transactions did we process each year?'],
  };
}

function headcount(): AnswerDraft {
  const rows = [
    ['Engineering', 142],
    ['Sales', 88],
    ['Customer Success', 54],
    ['Marketing', 31],
    ['Finance', 18],
    ['People', 12],
  ].map(([department, people]) => ({ department: department as string, headcount: people as number, avg_salary: null }));
  const hr = sourceRef('hr');
  return {
    summary: `There are ${rows.reduce((s, r) => s + r.headcount, 0)} employees across ${rows.length} departments. Engineering is the largest team. Salary figures are hidden by policy.`,
    highlights: [{ label: 'Total headcount', value: String(rows.reduce((s, r) => s + r.headcount, 0)) }],
    sources: [hr],
    explanation: 'I counted active employees per department in the HR System. Compensation is masked for everyone by the data policy.',
    generatedQueries: [
      {
        source: hr,
        language: 'sql',
        text: `SELECT e.department, COUNT(*) AS headcount, AVG(c.salary) AS avg_salary
FROM dbo.employees e
JOIN dbo.compensation c ON c.employee_id = e.employee_id
GROUP BY e.department
ORDER BY headcount DESC;`,
      },
    ],
    result: {
      kind: 'table',
      columns: [
        { key: 'department', label: 'Department', type: 'string' },
        { key: 'headcount', label: 'Headcount', type: 'number' },
        { key: 'avg_salary', label: 'Average salary', type: 'currency', masked: true },
      ],
      rows,
      totalRows: rows.length,
    },
    chart: { type: 'bar', x: 'department', series: ['headcount'] },
    followUps: [],
  };
}

function combined(): AnswerDraft {
  const regions = salesByRegion(false);
  const orders = delayedOrders();
  const queries: GeneratedQuery[] = [...(regions.generatedQueries ?? []), ...(orders.generatedQueries ?? [])];
  return {
    summary: `Last month's sales were led by North America, and ${(orders.result as { totalRows: number }).totalRows} orders are currently delayed in shipping — mostly enterprise customers in North America and Europe.`,
    highlights: [...regions.highlights.slice(0, 2), orders.highlights[0]],
    sources: [sourceRef('sales-db'), sourceRef('order-events')],
    explanation: 'I answered this in two parts: sales by region from the Sales Database, and delayed orders from the Order Events collection.',
    generatedQueries: queries,
    result: {
      kind: 'multi',
      parts: [
        { source: sourceRef('sales-db'), result: regions.result as TableResult },
        { source: sourceRef('order-events'), result: orders.result as Exclude<Answer['result'], { kind: 'multi' }> },
      ],
    },
    followUps: ['Which carrier has the most delays this month?'],
  };
}

/* ───────────── Planner ───────────── */

const has = (text: string, pattern: RegExp) => pattern.test(text);

export function plan(ctx: PlanContext): Plan {
  const q = ctx.question.toLowerCase().trim();
  const words = q.split(/\s+/).filter((word) => /[a-z]/.test(word));

  const pick = (sourceIds: string[], build: () => AnswerDraft | Plan): Plan => {
    const refs = sourceIds.map(sourceRef);
    const blocked = refs.find((ref) => !ctx.allowedSourceIds.has(ref.id));
    if (blocked) {
      return {
        kind: 'error',
        sources: refs,
        error: {
          code: 'forbidden',
          message: `This question needs data from ${blocked.name}, which your role can't access.`,
          source: blocked,
          canRequestAccess: true,
        },
      };
    }
    if (ctx.selectedSourceIds.length && !sourceIds.some((id) => ctx.selectedSourceIds.includes(id))) {
      return {
        kind: 'error',
        sources: refs,
        error: {
          code: 'not_understood',
          message: "The data sources you selected don't contain this information.",
          hint: `Switch the source picker to Auto, or include ${refs.map((ref) => ref.name).join(' and ')}.`,
        },
      };
    }
    const offline = sources.find((source) => sourceIds.includes(source.id) && source.status === 'offline');
    if (offline) {
      return {
        kind: 'error',
        sources: refs,
        error: {
          code: 'source_offline',
          message: `${offline.name} isn't responding right now. The data team has been notified automatically.`,
          hint: 'Try again later.',
          source: sourceRef(offline.id),
        },
      };
    }
    const built = build();
    return 'kind' in built ? built : { kind: 'answer', draft: built, sources: refs };
  };

  if (words.length < 2) {
    return {
      kind: 'error',
      sources: [],
      error: {
        code: 'not_understood',
        message: 'Try asking a full question, like “What were total sales by region last month?”',
      },
    };
  }
  if (has(q, /\b(delete|drop|update|insert|truncate|alter|remove all|change the)\b/)) {
    return {
      kind: 'error',
      sources: [],
      error: {
        code: 'write_blocked',
        message: "CodeLens can look data up, but it can never change, add or delete records.",
        hint: 'Ask a question about the data instead, or contact the system owner to make changes.',
      },
    };
  }
  if (has(q, /salar|payroll|headcount|employee|\bhr\b/)) return pick(['hr'], headcount);
  if (has(q, /invoice|billing|unpaid/)) return pick(['billing-legacy'], topProducts);
  if (has(q, /click|clickstream|page view/)) {
    return pick(['warehouse'], () => ({
      kind: 'error',
      sources: [sourceRef('warehouse')],
      error: {
        code: 'timeout',
        message: 'That question needed to scan billions of rows and took longer than the 120-second limit.',
        hint: 'Add a date range (e.g. “last week”) or a specific customer to make it faster.',
        source: sourceRef('warehouse'),
      },
    }));
  }
  if (has(q, /transaction|lifetime value|\bltv\b|each year|per year|all time/)) {
    const listing = has(q, /\b(list|all transactions|every transaction|show all)\b/);
    if (listing && !ctx.confirmed) {
      return pick(['warehouse'], () => ({
        kind: 'confirm',
        sources: [sourceRef('warehouse')],
        confirmation: {
          message: 'This will scan the full transaction history (about 1.2 million rows) and may take a while.',
          source: sourceRef('warehouse'),
          estimate: { bytesScanned: 48.2 * 1024 ** 3, seconds: 35, rows: 1_248_330, credits: 0.9 },
        },
      }));
    }
    return pick(['warehouse'], listing ? transactionList : transactionsByYear);
  }
  if (has(q, /session|right now|online|active users|using the app|feature flag|\bflags?\b/)) return pick(['live-cache'], liveStats);
  if (has(q, /compare|combined|both|together|and delayed/)) return pick(['sales-db', 'order-events'], combined);
  if (has(q, /ship|delivery|delayed|tracking|latest orders|order status/)) return pick(['order-events'], delayedOrders);
  if (has(q, /customer|client|account|renew|\bmrr\b|enterprise/)) return pick(['crm'], renewals);
  if (has(q, /revenue|sales|sold|product|region|month/)) {
    const byRegion = has(q, /region/);
    if (!byRegion && has(q, /monthly|trend|over time|this year|by month|each month|compared/)) return pick(['sales-db'], monthlyTrend);
    if (!byRegion && has(q, /product|top|best/)) return pick(['sales-db'], topProducts);
    if (has(q, /revenue/) && !has(q, /gross|net/) && !ctx.clarificationOptionId) {
      return pick(['sales-db'], () => ({
        kind: 'clarify',
        sources: [sourceRef('sales-db')],
        clarification: {
          question: 'Which revenue do you mean?',
          options: [
            { id: 'gross', label: 'Gross revenue', description: 'Order totals before refunds' },
            { id: 'net', label: 'Net revenue', description: 'After refunds and chargebacks' },
          ],
        },
      }));
    }
    return pick(['sales-db'], () => salesByRegion(ctx.clarificationOptionId === 'net' || has(q, /\bnet\b/)));
  }
  return {
    kind: 'error',
    sources: [],
    error: {
      code: 'not_understood',
      message: "I couldn't match that to any data you have access to.",
      hint: 'Try rephrasing with the business terms you would use with a colleague, or browse “What can I ask?” for examples.',
    },
  };
}
