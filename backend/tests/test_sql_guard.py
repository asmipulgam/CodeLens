"""The SQL gate: only one read-only query, over exposed tables and columns, with hidden values safe."""

from __future__ import annotations

import pytest

from app.pipeline.sql_guard import ExposedColumn, ExposedTable, QueryRejected, guard

C = ExposedColumn
TABLES = [
    ExposedTable(
        "sales",
        "orders",
        (
            C("id", "int", False),
            C("amount", "numeric", False),
            C("status", "text", False),
            C("ordered_at", "date", False),
            C("customer_id", "int", False),
        ),
    ),
    ExposedTable(
        "sales", "customers", (C("id", "int", False), C("name", "text", False), C("email", "text", True))
    ),
]


def ok(sql: str, source_type: str = "postgresql", row_limit: int = 500):  # type: ignore[no-untyped-def]
    return guard(sql, source_type=source_type, exposed=TABLES, row_limit=row_limit)


def rejected(sql: str) -> str:
    with pytest.raises(QueryRejected) as error:
        ok(sql)
    return str(error.value)


@pytest.mark.parametrize(
    ("sql", "message"),
    [
        ("DELETE FROM orders", "read-only"),
        ("UPDATE orders SET amount = 0", "read-only"),
        ("INSERT INTO orders (id) VALUES (1)", "read-only"),
        ("DROP TABLE orders", "read-only"),
        ("SELECT 1; DELETE FROM orders", "single query"),
        ("SELECT status FROM orders; SELECT name FROM customers", "single query"),
        ("SELECT * FROM orders FOR UPDATE", "read-only"),
        ("SELECT amount INTO copy_of_orders FROM orders", "read-only"),
        ("WITH gone AS (DELETE FROM orders RETURNING id) SELECT id FROM gone", "read-only"),
        ("SELECT pg_sleep(10)", "pg_sleep"),
        ("SELECT pg_read_file('/etc/passwd')", "pg_read_file"),
        ("SELECT dblink('host=evil', 'SELECT 1')", "dblink"),
        ("SELECT set_config('statement_timeout', '0', false)", "set_config"),
        ("SELECT * FROM hr.salaries", "isn't one you can ask about"),
        ("SELECT usename, passwd FROM pg_catalog.pg_shadow", "isn't one you can ask about"),
        ("SELECT table_name FROM information_schema.tables", "isn't one you can ask about"),
        ("SELECT secret_column FROM orders", "isn't available"),
        ("SELECT name FROM customers WHERE email LIKE '%@gmail.com'", "hidden"),
        ("SELECT COUNT(CASE WHEN email LIKE 'a%' THEN 1 END) FROM customers", "hidden"),
        ("SELECT name FROM customers ORDER BY email", "hidden"),
        ("SELECT email, COUNT(*) FROM customers GROUP BY email", "hidden"),
        ("SELECT LENGTH(email) FROM customers", "hidden"),
        ("WITH t AS (SELECT email FROM customers) SELECT email FROM t", "hidden"),
        ("SELECT name FROM customers WHERE id IN (SELECT id FROM customers WHERE email = 'x')", "hidden"),
        ("SELECT status FROM orders LIMIT ALL", "plain number"),
        ("", "empty"),
        ("not sql at all (", "couldn't be read"),
    ],
)
def test_dangerous_or_leaky_queries_are_refused(sql: str, message: str) -> None:
    assert message in rejected(sql)


def test_hidden_columns_come_back_as_null() -> None:
    result = ok("SELECT name, email FROM customers")
    assert 'NULL AS "email"' in result.sql
    assert result.masked_outputs == {"email"}
    star = ok("SELECT * FROM customers")
    assert 'NULL AS "email"' in star.sql and '"customers"."name"' in star.sql


def test_counting_hidden_values_is_allowed() -> None:
    result = ok("SELECT COUNT(email) AS with_email, COUNT(DISTINCT email) AS distinct_emails FROM customers")
    assert result.masked_outputs == set()


def test_tables_are_pinned_to_their_schema_and_limited() -> None:
    result = ok("SELECT status, SUM(amount) AS total FROM orders GROUP BY status")
    assert '"sales"."orders"' in result.sql
    assert result.sql.endswith("LIMIT 501")
    assert result.tables == [("sales", "orders")]
    assert "COUNT(*)" in result.count_sql and "LIMIT" not in result.count_sql


def test_a_smaller_limit_is_kept_and_a_larger_one_capped() -> None:
    assert ok("SELECT status FROM orders LIMIT 5").sql.endswith("LIMIT 5")
    assert ok("SELECT status FROM orders LIMIT 100000", row_limit=50).sql.endswith("LIMIT 51")


def test_joins_ctes_and_unions_over_exposed_tables_work() -> None:
    ok("SELECT o.status, c.name FROM orders o JOIN customers c ON c.id = o.customer_id")
    ok("WITH t AS (SELECT status, amount FROM orders) SELECT status, SUM(amount) AS s FROM t GROUP BY status")
    ok("SELECT status FROM orders UNION SELECT name FROM customers")
    ok("SELECT DATE_TRUNC('month', ordered_at) AS month, COUNT(*) AS n FROM orders GROUP BY 1")


def test_mysql_dialect() -> None:
    result = ok("SELECT `status`, COUNT(*) AS n FROM orders GROUP BY `status`", source_type="mysql")
    assert "`sales`.`orders`" in result.sql
    with pytest.raises(QueryRejected, match=r"(?i)sleep"):
        ok("SELECT SLEEP(5)", source_type="mysql")
    with pytest.raises(QueryRejected, match=r"(?i)load_file"):
        ok("SELECT LOAD_FILE('/etc/passwd')", source_type="mysql")


def test_unsupported_source_types() -> None:
    with pytest.raises(QueryRejected, match="can't be answered"):
        ok("SELECT 1", source_type="mongodb")
