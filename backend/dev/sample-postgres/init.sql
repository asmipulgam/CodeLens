-- Sample company database for trying CodeLens locally. Development only.
CREATE SCHEMA sales;

CREATE TABLE sales.regions (
    id   serial PRIMARY KEY,
    name text NOT NULL
);
CREATE TABLE sales.customers (
    id         serial PRIMARY KEY,
    name       text NOT NULL,
    email      text NOT NULL,
    phone      text,
    region_id  int NOT NULL REFERENCES sales.regions(id),
    created_at date NOT NULL
);
CREATE TABLE sales.products (
    id         serial PRIMARY KEY,
    name       text NOT NULL,
    category   text NOT NULL,
    unit_price numeric(10, 2) NOT NULL
);
CREATE TABLE sales.orders (
    id          serial PRIMARY KEY,
    customer_id int NOT NULL REFERENCES sales.customers(id),
    product_id  int NOT NULL REFERENCES sales.products(id),
    quantity    int NOT NULL,
    amount      numeric(12, 2) NOT NULL,
    status      text NOT NULL,
    ordered_at  date NOT NULL
);

INSERT INTO sales.regions (name) VALUES ('North America'), ('Europe'), ('Asia Pacific'), ('Latin America');
INSERT INTO sales.products (name, category, unit_price) VALUES
    ('Starter plan', 'Subscription', 49), ('Team plan', 'Subscription', 199), ('Enterprise plan', 'Subscription', 999),
    ('Onboarding', 'Services', 1500), ('Training day', 'Services', 2500), ('Extra storage', 'Add-on', 25);
INSERT INTO sales.customers (name, email, phone, region_id, created_at)
SELECT 'Customer ' || g, 'contact' || g || '@example.com', '+1-555-' || lpad(g::text, 4, '0'),
       1 + (g % 4), DATE '2024-01-01' + (g * 3)
FROM generate_series(1, 200) AS g;
INSERT INTO sales.orders (customer_id, product_id, quantity, amount, status, ordered_at)
SELECT 1 + (g % 200), 1 + (g % 6), 1 + (g % 5),
       (1 + (g % 5)) * (SELECT unit_price FROM sales.products p WHERE p.id = 1 + (g % 6)),
       (ARRAY['paid', 'paid', 'paid', 'shipped', 'cancelled', 'refunded'])[1 + (g % 6)],
       DATE '2025-01-01' + (g % 680)
FROM generate_series(1, 5000) AS g;

CREATE VIEW sales.monthly_revenue AS
SELECT date_trunc('month', ordered_at)::date AS month, r.name AS region, sum(o.amount) AS revenue
FROM sales.orders o JOIN sales.customers c ON c.id = o.customer_id JOIN sales.regions r ON r.id = c.region_id
WHERE o.status IN ('paid', 'shipped')
GROUP BY 1, 2;

-- Confidential data the CodeLens account must NOT see.
CREATE SCHEMA hr;
CREATE TABLE hr.salaries (employee text, salary numeric(10, 2));
INSERT INTO hr.salaries VALUES ('Dana Okafor', 120000), ('Marcus Lee', 95000);

-- The account CodeLens should use: SELECT on the sales schema only.
CREATE ROLE codelens_reader LOGIN PASSWORD 'reader-dev';
GRANT USAGE ON SCHEMA sales TO codelens_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA sales TO codelens_reader;

-- A wrongly configured account, to see the read-only check refuse it.
CREATE ROLE codelens_writer LOGIN PASSWORD 'writer-dev';
GRANT USAGE ON SCHEMA sales TO codelens_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA sales TO codelens_writer;
GRANT INSERT, UPDATE ON sales.orders TO codelens_writer;
