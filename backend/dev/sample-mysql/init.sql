-- Sample company database for trying CodeLens locally. Development only.
-- MYSQL_DATABASE=sales is created by the image; this runs inside it.
CREATE TABLE regions (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) NOT NULL);
CREATE TABLE customers (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(200) NOT NULL,
    region_id INT NOT NULL, created_at DATE NOT NULL
);
CREATE TABLE orders (
    id INT AUTO_INCREMENT PRIMARY KEY, customer_id INT NOT NULL, amount DECIMAL(12, 2) NOT NULL,
    status VARCHAR(20) NOT NULL, ordered_at DATE NOT NULL
);
INSERT INTO regions (name) VALUES ('North America'), ('Europe'), ('Asia Pacific');
INSERT INTO customers (name, email, region_id, created_at) VALUES
    ('Acme Corp', 'buyer@acme.example', 1, '2024-02-01'),
    ('Globex', 'ap@globex.example', 2, '2024-03-15'),
    ('Initech', 'it@initech.example', 3, '2024-05-20');
INSERT INTO orders (customer_id, amount, status, ordered_at) VALUES
    (1, 1200.00, 'paid', '2025-09-01'), (2, 450.50, 'shipped', '2025-09-12'), (3, 3000.00, 'paid', '2025-10-02');
CREATE VIEW revenue_by_region AS
    SELECT r.name AS region, SUM(o.amount) AS revenue
    FROM orders o JOIN customers c ON c.id = o.customer_id JOIN regions r ON r.id = c.region_id
    GROUP BY r.name;

-- The account CodeLens should use.
CREATE USER 'codelens_reader'@'%' IDENTIFIED BY 'reader-dev' REQUIRE SSL;
GRANT SELECT, SHOW VIEW ON sales.* TO 'codelens_reader'@'%';

-- Wrongly configured accounts: one with a direct write grant, one that gets it through a role.
CREATE USER 'codelens_writer'@'%' IDENTIFIED BY 'writer-dev' REQUIRE SSL;
GRANT SELECT, INSERT ON sales.* TO 'codelens_writer'@'%';
CREATE ROLE 'sales_editor';
GRANT UPDATE ON sales.* TO 'sales_editor';
CREATE USER 'codelens_role_user'@'%' IDENTIFIED BY 'role-dev' REQUIRE SSL;
GRANT SELECT ON sales.* TO 'codelens_role_user'@'%';
GRANT 'sales_editor' TO 'codelens_role_user'@'%';
SET DEFAULT ROLE ALL TO 'codelens_role_user'@'%';
