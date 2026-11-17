/**
 * Demo data for the mock backend. Everything here is fictional.
 * This module is only loaded when VITE_USE_MOCKS=true and is excluded from production builds.
 */
import type {
  AccessRequest,
  AdminSourceDetail,
  AdminUser,
  AuditEntry,
  Conversation,
  FeedbackItem,
  Permissions,
  Preferences,
  Role,
  RoleDefinition,
  SavedQuestion,
  SessionUser,
} from '@/api/types';

export const now = () => new Date();
export const isoMinutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
export const isoDaysAgo = (days: number) => isoMinutesAgo(days * 24 * 60);

export const ROLE_PERMISSIONS: Record<Role, Permissions> = {
  business: { canViewQuery: false, canExport: false, canChooseSource: false, canAdmin: false, canAudit: false, exportRowLimit: 0 },
  analyst: { canViewQuery: true, canExport: true, canChooseSource: true, canAdmin: false, canAudit: false, exportRowLimit: 10_000 },
  admin: { canViewQuery: true, canExport: true, canChooseSource: true, canAdmin: true, canAudit: true, exportRowLimit: 50_000 },
  auditor: { canViewQuery: true, canExport: false, canChooseSource: false, canAdmin: false, canAudit: true, exportRowLimit: 0 },
};

export const DEMO_USERS: Record<Role, SessionUser> = {
  business: { id: 'u-priya', name: 'Priya Shah', email: 'priya.shah@example.com', roles: ['business'], permissions: ROLE_PERMISSIONS.business },
  analyst: { id: 'u-marcus', name: 'Marcus Lee', email: 'marcus.lee@example.com', roles: ['analyst'], permissions: ROLE_PERMISSIONS.analyst },
  admin: { id: 'u-dana', name: 'Dana Okafor', email: 'dana.okafor@example.com', roles: ['admin'], permissions: ROLE_PERMISSIONS.admin },
  auditor: { id: 'u-sam', name: 'Sam Rivera', email: 'sam.rivera@example.com', roles: ['auditor'], permissions: ROLE_PERMISSIONS.auditor },
};

export const roles: RoleDefinition[] = [
  {
    id: 'business',
    name: 'Business user',
    description: 'Sales, support and account teams who answer client questions',
    permissions: ROLE_PERMISSIONS.business,
    sourceIds: ['sales-db', 'order-events', 'crm', 'live-cache', 'billing-legacy'],
    memberCount: 6,
    builtIn: true,
  },
  {
    id: 'analyst',
    name: 'Analyst',
    description: 'Can see generated queries, choose sources and export',
    permissions: ROLE_PERMISSIONS.analyst,
    sourceIds: ['sales-db', 'order-events', 'crm', 'live-cache', 'warehouse', 'billing-legacy'],
    memberCount: 2,
    builtIn: true,
  },
  {
    id: 'admin',
    name: 'Admin',
    description: 'Manages data sources, roles and the cache',
    permissions: ROLE_PERMISSIONS.admin,
    sourceIds: ['sales-db', 'order-events', 'crm', 'live-cache', 'warehouse', 'hr', 'billing-legacy'],
    memberCount: 1,
    builtIn: true,
  },
  {
    id: 'auditor',
    name: 'Auditor',
    description: 'Security and compliance reviewers (read-only)',
    permissions: ROLE_PERMISSIONS.auditor,
    sourceIds: [],
    memberCount: 1,
    builtIn: true,
  },
];

export const users: AdminUser[] = [
  { id: 'u-priya', name: 'Priya Shah', email: 'priya.shah@example.com', roleIds: ['business'], groups: ['Account Management'], lastActiveAt: isoMinutesAgo(4), status: 'active' },
  { id: 'u-marcus', name: 'Marcus Lee', email: 'marcus.lee@example.com', roleIds: ['analyst'], groups: ['Revenue Operations'], lastActiveAt: isoMinutesAgo(52), status: 'active' },
  { id: 'u-dana', name: 'Dana Okafor', email: 'dana.okafor@example.com', roleIds: ['admin'], groups: ['Data Platform', 'IT'], lastActiveAt: isoMinutesAgo(1), status: 'active' },
  { id: 'u-sam', name: 'Sam Rivera', email: 'sam.rivera@example.com', roleIds: ['auditor'], groups: ['Security'], lastActiveAt: isoDaysAgo(2), status: 'active' },
  { id: 'u-elena', name: 'Elena Novak', email: 'elena.novak@example.com', roleIds: ['business'], groups: ['Customer Support'], lastActiveAt: isoMinutesAgo(130), status: 'active' },
  { id: 'u-tomas', name: 'Tomás García', email: 'tomas.garcia@example.com', roleIds: ['business'], groups: ['Sales EMEA'], lastActiveAt: isoDaysAgo(1), status: 'active' },
  { id: 'u-aiko', name: 'Aiko Tanaka', email: 'aiko.tanaka@example.com', roleIds: ['business'], groups: ['Sales APAC'], lastActiveAt: isoDaysAgo(3), status: 'active' },
  { id: 'u-jordan', name: 'Jordan Blake', email: 'jordan.blake@example.com', roleIds: ['analyst'], groups: ['Finance'], lastActiveAt: isoDaysAgo(6), status: 'active' },
  { id: 'u-noor', name: 'Noor Haddad', email: 'noor.haddad@example.com', roleIds: ['business'], groups: ['Customer Support'], lastActiveAt: null, status: 'active' },
  { id: 'u-li', name: 'Li Wei', email: 'li.wei@example.com', roleIds: ['business'], groups: ['Sales APAC'], lastActiveAt: isoDaysAgo(40), status: 'disabled' },
];

const field = (name: string, type: string, description = '', masked = false) => ({ name, type, description, masked });

export const sources: AdminSourceDetail[] = [
  {
    id: 'sales-db',
    name: 'Sales Database',
    type: 'postgresql',
    description: 'Orders, products and regions from the online store and sales team. Updated in real time.',
    status: 'healthy',
    lastCheckedAt: isoMinutesAgo(3),
    owner: 'Revenue Operations',
    enabled: true,
    exposedCount: 4,
    cacheTtlSeconds: 900,
    connection: { host: 'sales-db.internal.example.com', port: 5432, database: 'sales', username: 'codelens_reader', sslMode: 'verify-full' },
    secrets: { password: { isSet: true, updatedAt: isoDaysAgo(41) } },
    exposed: [
      {
        namespace: 'public',
        name: 'orders',
        kind: 'table',
        description: 'One row per customer order, with its total, region and status.',
        fields: [
          field('order_id', 'bigint', 'Unique order number'),
          field('order_date', 'date', 'Date the order was placed'),
          field('region_id', 'int', 'Sales region'),
          field('customer_id', 'bigint', 'Customer who placed the order'),
          field('total_amount', 'numeric', 'Order total in USD, after discounts'),
          field('status', 'text', 'placed, shipped, delivered, cancelled or refunded'),
        ],
      },
      {
        namespace: 'public',
        name: 'order_items',
        kind: 'table',
        description: 'Products in each order.',
        fields: [field('order_id', 'bigint'), field('product_id', 'int'), field('quantity', 'int'), field('unit_price', 'numeric')],
      },
      {
        namespace: 'public',
        name: 'products',
        kind: 'table',
        description: 'Product catalogue.',
        fields: [field('product_id', 'int'), field('product_name', 'text'), field('category', 'text'), field('list_price', 'numeric')],
      },
      {
        namespace: 'public',
        name: 'regions',
        kind: 'table',
        description: 'Sales regions.',
        fields: [field('region_id', 'int'), field('region_name', 'text', 'e.g. North America, Europe')],
      },
    ],
    glossary: [
      { term: 'Revenue (gross)', definition: 'Sum of order totals before refunds. Cancelled orders are excluded.' },
      { term: 'Net revenue', definition: 'Gross revenue minus refunds and chargebacks.' },
      { term: 'Average order value', definition: 'Revenue divided by the number of orders.' },
    ],
    exampleQuestions: [
      'What were total sales by region last month?',
      'Show monthly revenue for this year compared with last year',
      'What are our top products by revenue?',
    ],
    roleIds: ['business', 'analyst', 'admin'],
    rowLimit: 500,
    queryTimeoutSeconds: 30,
  },
  {
    id: 'order-events',
    name: 'Order Events',
    type: 'mongodb',
    description: 'Live order tracking: items, shipping carrier, delivery status and estimated arrival.',
    status: 'healthy',
    lastCheckedAt: isoMinutesAgo(2),
    owner: 'Fulfilment Engineering',
    enabled: true,
    exposedCount: 1,
    cacheTtlSeconds: 300,
    connection: { hosts: 'mongo-1.internal:27017, mongo-2.internal:27017', replicaSet: 'rs0', database: 'fulfilment', authSource: 'admin', username: 'codelens_ro', tls: true },
    secrets: { password: { isSet: true, updatedAt: isoDaysAgo(12) } },
    exposed: [
      {
        namespace: 'fulfilment',
        name: 'orders',
        kind: 'collection',
        description: 'One document per order with nested customer, items and shipping details.',
        fields: [
          field('orderId', 'string', 'Order number shown to customers'),
          field('status', 'string'),
          field('customer.name', 'string'),
          field('customer.email', 'string', 'Customer email address', true),
          field('items', 'array', 'Products and quantities'),
          field('shipping.carrier', 'string'),
          field('shipping.status', 'string', 'in_transit, delayed, delivered'),
          field('shipping.eta', 'date', 'Estimated delivery date'),
        ],
      },
    ],
    glossary: [{ term: 'Delayed', definition: 'Shipping status is “delayed” or the ETA has passed without delivery.' }],
    exampleQuestions: ['Which orders are delayed in shipping?', 'Show the latest orders for Acme Corp'],
    roleIds: ['business', 'analyst', 'admin'],
    rowLimit: 500,
    queryTimeoutSeconds: 20,
  },
  {
    id: 'warehouse',
    name: 'Analytics Warehouse',
    type: 'snowflake',
    description: 'Ten years of transaction history and customer analytics. Large — some questions can be slow.',
    status: 'healthy',
    lastCheckedAt: isoMinutesAgo(9),
    owner: 'Data Platform',
    enabled: true,
    exposedCount: 2,
    cacheTtlSeconds: 21_600,
    connection: { account: 'exampleco-analytics', warehouse: 'CODELENS_WH', database: 'ANALYTICS', schema: 'CORE', role: 'CODELENS_READER', username: 'CODELENS_SVC', authMethod: 'keypair' },
    secrets: { privateKey: { isSet: true, updatedAt: isoDaysAgo(88) }, privateKeyPassphrase: { isSet: true, updatedAt: isoDaysAgo(88) } },
    exposed: [
      {
        namespace: 'CORE',
        name: 'TRANSACTIONS',
        kind: 'table',
        description: 'Every payment transaction since 2016.',
        fields: [
          field('TRANSACTION_ID', 'VARCHAR'),
          field('TRANSACTION_DATE', 'DATE'),
          field('CUSTOMER_ID', 'NUMBER'),
          field('AMOUNT_USD', 'NUMBER'),
          field('CHANNEL', 'VARCHAR', 'web, mobile, partner or sales'),
          field('CARD_LAST4', 'VARCHAR', 'Last four digits of the card', true),
        ],
      },
      {
        namespace: 'CORE',
        name: 'CUSTOMER_LTV',
        kind: 'view',
        description: 'Lifetime value per customer.',
        fields: [field('CUSTOMER_ID', 'NUMBER'), field('LIFETIME_VALUE_USD', 'NUMBER'), field('FIRST_ORDER_DATE', 'DATE')],
      },
    ],
    glossary: [{ term: 'Lifetime value (LTV)', definition: 'Total net revenue from a customer since their first order.' }],
    exampleQuestions: ['How many transactions did we process each year?', 'List all transactions from the partner channel'],
    roleIds: ['analyst', 'admin'],
    rowLimit: 500,
    queryTimeoutSeconds: 120,
  },
  {
    id: 'live-cache',
    name: 'Live Sessions',
    type: 'redis',
    description: 'Real-time counters, active sessions and feature flags for the customer app.',
    status: 'healthy',
    lastCheckedAt: isoMinutesAgo(1),
    owner: 'Platform Engineering',
    enabled: true,
    exposedCount: 3,
    cacheTtlSeconds: 60,
    connection: { host: 'redis.internal.example.com', port: 6379, dbIndex: 0, username: 'codelens-readonly', tls: true },
    secrets: { password: { isSet: true, updatedAt: isoDaysAgo(5) } },
    exposed: [
      { namespace: 'db0', name: 'stats:*', kind: 'keyPattern', description: 'Live usage counters.', fields: [] },
      { namespace: 'db0', name: 'flags:*', kind: 'keyPattern', description: 'Feature flags and their rollout percentage.', fields: [] },
      { namespace: 'db0', name: 'leaderboard:*', kind: 'keyPattern', description: 'Ranked lists such as most active accounts.', fields: [] },
    ],
    glossary: [{ term: 'Active user', definition: 'Someone who used the app in the last 5 minutes.' }],
    exampleQuestions: ['How many people are using the app right now?', 'Which feature flags are turned on?'],
    roleIds: ['business', 'analyst', 'admin'],
    rowLimit: 200,
    queryTimeoutSeconds: 5,
  },
  {
    id: 'crm',
    name: 'Customer CRM',
    type: 'mysql',
    description: 'Customer accounts, plans, renewals and contacts.',
    status: 'degraded',
    lastCheckedAt: isoMinutesAgo(6),
    owner: 'Customer Success',
    enabled: true,
    exposedCount: 2,
    cacheTtlSeconds: 3600,
    connection: { host: 'crm-db.internal.example.com', port: 3306, database: 'crm', username: 'codelens_ro', tlsMode: 'VERIFY_IDENTITY' },
    secrets: { password: { isSet: true, updatedAt: isoDaysAgo(19) } },
    exposed: [
      {
        namespace: 'crm',
        name: 'accounts',
        kind: 'table',
        description: 'One row per customer company.',
        fields: [
          field('company', 'varchar'),
          field('plan', 'varchar', 'Starter, Growth or Enterprise'),
          field('mrr', 'decimal', 'Monthly recurring revenue in USD'),
          field('renewal_date', 'date'),
          field('health', 'varchar', 'Good, At risk or Critical'),
        ],
      },
      {
        namespace: 'crm',
        name: 'contacts',
        kind: 'table',
        description: 'People at customer companies.',
        fields: [field('name', 'varchar'), field('email', 'varchar', '', true), field('phone', 'varchar', '', true), field('company', 'varchar')],
      },
    ],
    glossary: [
      { term: 'MRR', definition: 'Monthly recurring revenue from a subscription.' },
      { term: 'At risk', definition: 'Health score below 60 or a support escalation in the last 30 days.' },
    ],
    exampleQuestions: ['Which customers renew in the next 30 days?', 'List our enterprise accounts by MRR'],
    roleIds: ['business', 'analyst', 'admin'],
    rowLimit: 500,
    queryTimeoutSeconds: 30,
  },
  {
    id: 'hr',
    name: 'HR System',
    type: 'sqlserver',
    description: 'Employees, departments and compensation. Restricted.',
    status: 'healthy',
    lastCheckedAt: isoMinutesAgo(11),
    owner: 'People Team',
    enabled: true,
    exposedCount: 2,
    cacheTtlSeconds: 86_400,
    connection: { host: 'hr-sql.internal.example.com', port: 1433, database: 'People', username: 'codelens_reader', encrypt: 'strict' },
    secrets: { password: { isSet: true, updatedAt: isoDaysAgo(60) } },
    exposed: [
      {
        namespace: 'dbo',
        name: 'employees',
        kind: 'table',
        description: 'Current employees.',
        fields: [field('employee_id', 'int'), field('department', 'nvarchar'), field('start_date', 'date'), field('email', 'nvarchar', '', true)],
      },
      {
        namespace: 'dbo',
        name: 'compensation',
        kind: 'table',
        description: 'Salary bands.',
        fields: [field('employee_id', 'int'), field('salary', 'money', '', true)],
      },
    ],
    glossary: [{ term: 'Headcount', definition: 'Number of active employees on the last day of the period.' }],
    exampleQuestions: ['What is our headcount by department?'],
    roleIds: ['admin'],
    rowLimit: 200,
    queryTimeoutSeconds: 30,
  },
  {
    id: 'billing-legacy',
    name: 'Billing (Legacy)',
    type: 'oracle',
    description: 'Invoices and payments before the 2024 billing migration.',
    status: 'offline',
    lastCheckedAt: isoMinutesAgo(4),
    owner: 'Finance Systems',
    enabled: true,
    exposedCount: 1,
    cacheTtlSeconds: 86_400,
    connection: { host: 'billing-ora.internal.example.com', port: 1521, serviceName: 'BILLPDB', username: 'CODELENS_RO', useTls: true },
    secrets: { password: { isSet: true, updatedAt: isoDaysAgo(200) } },
    exposed: [
      {
        namespace: 'BILLING',
        name: 'INVOICES',
        kind: 'table',
        description: 'Invoices issued before 2024.',
        fields: [field('INVOICE_NO', 'VARCHAR2'), field('CUSTOMER', 'VARCHAR2'), field('AMOUNT', 'NUMBER'), field('PAID', 'CHAR')],
      },
    ],
    glossary: [],
    exampleQuestions: ['Show unpaid invoices from 2023'],
    roleIds: ['business', 'analyst', 'admin'],
    rowLimit: 500,
    queryTimeoutSeconds: 30,
  },
];

export const preferences = new Map<string, Preferences>([
  ['u-priya', { showGeneratedQuery: false, defaultSourceIds: [] }],
  ['u-marcus', { showGeneratedQuery: true, defaultSourceIds: [] }],
  ['u-dana', { showGeneratedQuery: true, defaultSourceIds: [] }],
  ['u-sam', { showGeneratedQuery: true, defaultSourceIds: [] }],
]);

/** Extra per-user source grants from approved access requests. */
export const userGrants = new Map<string, Set<string>>();

export const accessRequests: AccessRequest[] = [
  {
    id: 'ar-1',
    user: { id: 'u-elena', name: 'Elena Novak', email: 'elena.novak@example.com' },
    source: { id: 'warehouse', name: 'Analytics Warehouse', type: 'snowflake' },
    reason: 'Clients ask about their multi-year purchase history and I need transactions older than 12 months.',
    status: 'pending',
    createdAt: isoMinutesAgo(95),
  },
  {
    id: 'ar-2',
    user: { id: 'u-tomas', name: 'Tomás García', email: 'tomas.garcia@example.com' },
    source: { id: 'warehouse', name: 'Analytics Warehouse', type: 'snowflake' },
    reason: 'Quarterly business reviews with EMEA accounts need lifetime value figures.',
    status: 'pending',
    createdAt: isoDaysAgo(1),
  },
  {
    id: 'ar-3',
    user: { id: 'u-jordan', name: 'Jordan Blake', email: 'jordan.blake@example.com' },
    source: { id: 'hr', name: 'HR System', type: 'sqlserver' },
    reason: 'Budget planning needs headcount per department.',
    status: 'rejected',
    createdAt: isoDaysAgo(9),
    decidedBy: 'Dana Okafor',
    decidedAt: isoDaysAgo(8),
    note: 'Please use the monthly headcount report from the People team instead.',
  },
];

export const conversations = new Map<string, Conversation & { ownerId: string }>();
export const savedQuestions = new Map<string, SavedQuestion[]>([
  [
    'u-priya',
    [
      { id: 'sq-1', question: 'Which orders are delayed in shipping?', sourceIds: ['order-events'], createdAt: isoDaysAgo(3) },
      { id: 'sq-2', question: 'Which customers renew in the next 30 days?', sourceIds: ['crm'], createdAt: isoDaysAgo(10) },
    ],
  ],
  ['u-marcus', [{ id: 'sq-3', question: 'Show monthly revenue for this year compared with last year', sourceIds: ['sales-db'], createdAt: isoDaysAgo(2) }]],
]);

export const feedback: FeedbackItem[] = [
  {
    id: 'fb-1',
    queryId: 'q-seed-12',
    question: 'What was net revenue for Europe in Q3?',
    user: 'Tomás García',
    reason: 'wrong_numbers',
    comment: 'Finance report says about $2.7M, this showed $2.9M. Maybe refunds are not included?',
    createdAt: isoDaysAgo(1),
  },
  {
    id: 'fb-2',
    queryId: 'q-seed-27',
    question: 'How many tickets did Acme open last week?',
    user: 'Elena Novak',
    reason: 'wrong_source',
    comment: 'Support tickets are in Zendesk, not the CRM.',
    createdAt: isoDaysAgo(4),
  },
];

export const audit: AuditEntry[] = [];

let counter = 1000;
export const nextId = (prefix: string) => `${prefix}-${(counter += 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
