/*
 * Seed data for the browser-only QA Lite demo.
 *
 * Mirrors the original Oracle schema (V1__init_schema.sql): users, environments, sql_definitions,
 * user_allowed_env, user_allowed_sql, execution_history. On first load mock-api.js copies this
 * into localStorage; after that the stored copy is the source of truth (QaLite.resetDemoData()
 * restores this seed).
 *
 * targetDatabaseTemplate is the content of each environment's mock target database - the tables
 * the in-browser SQL engine (mock-sql-engine.js) runs admin-defined SQL against.
 */
(function (global) {
    "use strict";

    const DATABASE_TYPES = [
        { value: "POSTGRESQL", label: "PostgreSQL", jdbcPrefix: "jdbc:postgresql:" },
        { value: "ORACLE", label: "Oracle", jdbcPrefix: "jdbc:oracle:" },
        { value: "MYSQL", label: "MySQL", jdbcPrefix: "jdbc:mysql:" },
        { value: "MONGODB_ATLAS_SQL", label: "MongoDB Atlas SQL", jdbcPrefix: "jdbc:mongodb:" }
    ];

    // Demo passwords (shown on the login page): admin/admin123, qa_user/qauser123,
    // sara.qa/sara12345, khalid.ops/khalid123. Stored as SHA-256 of "qalite-demo:" + password.
    const users = [
        { userId: 1, username: "admin", passwordHash: "e902c642b6b4f83c73b94f60219abafbff793d89f8dc24d44b32beb548171825", role: "ADMIN", createdAt: "2026-09-01T08:00:00Z" },
        { userId: 2, username: "qa_user", passwordHash: "521ce1ddc0c41ab4d82e0fb259690673e0ad4855a3c30bcf9ebf403427615f78", role: "QA_USER", createdAt: "2026-09-02T09:15:00Z" },
        { userId: 3, username: "sara.qa", passwordHash: "c9d3811bda4274ce2b31951420d1e702da726ca3723d434f2c8d7d3f1c0399ee", role: "QA_USER", createdAt: "2026-09-10T11:30:00Z" },
        { userId: 4, username: "khalid.ops", passwordHash: "7d1342a9e553e9d8e7fcd5050d808398ace754a737e8df34ad898be9a0006e68", role: "QA_USER", createdAt: "2026-09-21T07:45:00Z" }
    ];

    const environments = [
        { envId: 1, name: "SIT", description: "System integration testing environment", dbType: "POSTGRESQL", jdbcUrl: "jdbc:postgresql://sit.example.local:5432/appdb", dbUsername: "qa_readonly" },
        { envId: 2, name: "UAT", description: "User acceptance testing environment", dbType: "POSTGRESQL", jdbcUrl: "jdbc:postgresql://uat.example.local:5432/appdb", dbUsername: "qa_readonly" },
        { envId: 3, name: "PREPROD", description: "Pre-production mirror", dbType: "ORACLE", jdbcUrl: "jdbc:oracle:thin:@//preprod.example.local:1521/QAPDB", dbUsername: "qa_app" },
        { envId: 4, name: "DEV", description: "", dbType: "MYSQL", jdbcUrl: "jdbc:mysql://dev.example.local:3306/appdb", dbUsername: "qa_dev" }
    ];

    const sqlDefinitions = [
        {
            sqlId: 1,
            sqlName: "Get Sample Customers",
            sqlDescription: "Returns a small sample customer list",
            sqlText: "select 101 as customer_id, 'Ahmed' as customer_name union all select 102, 'Sara'"
        },
        {
            sqlId: 2,
            sqlName: "Count Sample Orders",
            sqlDescription: "Returns a sample order count",
            sqlText: "select 42 as order_count"
        },
        {
            sqlId: 3,
            sqlName: "Get Customer Info",
            sqlDescription: "Returns customer details",
            sqlText: "select customer_id, customer_name, msisdn, city, status\nfrom customers\nwhere customer_name = :customer_name"
        },
        {
            sqlId: 4,
            sqlName: "Find Subscription by MSISDN",
            sqlDescription: "Looks up the active plan for a mobile number",
            sqlText: "select s.subscription_id, s.msisdn, s.plan_name, s.status, s.activated_on\nfrom subscriptions s\nwhere s.msisdn = :msisdn"
        },
        {
            sqlId: 5,
            sqlName: "List Pending Orders",
            sqlDescription: "Orders still waiting for fulfilment",
            sqlText: "select o.order_id, c.customer_name, o.product, o.amount, o.created_at\nfrom orders o\njoin customers c on c.customer_id = o.customer_id\nwhere o.status = 'PENDING'\norder by o.order_id"
        },
        {
            sqlId: 6,
            sqlName: "Orders by City",
            sqlDescription: "Order totals per city",
            sqlText: "select c.city, count(*) as order_count, sum(o.amount) as total_amount\nfrom orders o\njoin customers c on c.customer_id = o.customer_id\ngroup by c.city\norder by total_amount desc"
        },
        {
            sqlId: 7,
            sqlName: "Reset Order Status",
            sqlDescription: "Moves an order back to PENDING",
            sqlText: "update orders set status = 'PENDING' where order_id = :order_id"
        }
    ];

    const userAllowedEnv = [
        { userId: 2, envId: 1 },
        { userId: 2, envId: 2 },
        { userId: 3, envId: 2 }
    ];

    const userAllowedSql = [
        { userId: 2, sqlId: 1 },
        { userId: 2, sqlId: 2 },
        { userId: 2, sqlId: 3 },
        { userId: 2, sqlId: 4 },
        { userId: 3, sqlId: 3 },
        { userId: 3, sqlId: 5 }
    ];

    const executionHistory = [
        { executionId: 1, userId: 2, envId: 1, sqlId: 1, startedAt: "2026-10-14T10:02:11Z", status: "SUCCESS", recordsReturned: 2, rowsAffected: null, errorMessage: null, clientIp: "127.0.0.1" },
        { executionId: 2, userId: 3, envId: 2, sqlId: 3, startedAt: "2026-10-15T13:47:52Z", status: "SUCCESS", recordsReturned: 1, rowsAffected: null, errorMessage: null, clientIp: "127.0.0.1" }
    ];

    const column = (name, type) => ({ name, type });
    const rowsFrom = (columns, values) => values.map((row) => Object.fromEntries(columns.map((col, index) => [col.name, row[index]])));
    const table = (columns, autoIncrement, values) => ({ columns, autoIncrement, rows: rowsFrom(columns, values) });

    const customerColumns = [
        column("customer_id", "number"),
        column("customer_name", "text"),
        column("msisdn", "text"),
        column("city", "text"),
        column("status", "text"),
        column("segment", "text")
    ];

    const subscriptionColumns = [
        column("subscription_id", "number"),
        column("customer_id", "number"),
        column("msisdn", "text"),
        column("plan_name", "text"),
        column("status", "text"),
        column("activated_on", "text")
    ];

    const orderColumns = [
        column("order_id", "number"),
        column("customer_id", "number"),
        column("product", "text"),
        column("amount", "number"),
        column("status", "text"),
        column("created_at", "text")
    ];

    const targetDatabaseTemplate = () => ({
        customers: table(customerColumns, "customer_id", [
            [101, "Ahmed", "966501234567", "Riyadh", "ACTIVE", "Consumer"],
            [102, "Sara", "966502345678", "Jeddah", "ACTIVE", "Consumer"],
            [103, "Mohammed", "966503456789", "Dammam", "SUSPENDED", "Business"],
            [104, "Noura", "966504567890", "Riyadh", "ACTIVE", "Business"],
            [105, "Faisal", "966505678901", "Mecca", "ACTIVE", "Consumer"],
            [106, "Layla", "966506789012", "Medina", "INACTIVE", "Consumer"],
            [107, "Omar", "966507890123", "Jeddah", "ACTIVE", "Enterprise"],
            [108, "Huda", "966508901234", "Khobar", "ACTIVE", "Consumer"]
        ]),
        subscriptions: table(subscriptionColumns, "subscription_id", [
            [5001, 101, "966501234567", "Postpaid 300", "ACTIVE", "2025-03-14"],
            [5002, 102, "966502345678", "Prepaid Unlimited", "ACTIVE", "2025-07-02"],
            [5003, 103, "966503456789", "Business Pro", "SUSPENDED", "2024-11-20"],
            [5004, 104, "966504567890", "Business Pro", "ACTIVE", "2025-01-09"],
            [5005, 105, "966505678901", "Postpaid 150", "ACTIVE", "2026-02-18"],
            [5006, 106, "966506789012", "Prepaid Basic", "CANCELLED", "2023-08-30"],
            [5007, 107, "966507890123", "Enterprise Fiber", "ACTIVE", "2026-05-05"],
            [5008, 108, "966508901234", "Postpaid 300", "ACTIVE", "2026-08-21"]
        ]),
        orders: table(orderColumns, "order_id", [
            [9001, 101, "iPhone 17 Pro", 5299, "DELIVERED", "2026-09-28"],
            [9002, 102, "5G Router", 899, "PENDING", "2026-10-02"],
            [9003, 104, "Data Add-on 50GB", 150, "DELIVERED", "2026-10-03"],
            [9004, 107, "Fiber Installation", 1200, "PENDING", "2026-10-05"],
            [9005, 105, "eSIM Activation", 25, "CANCELLED", "2026-10-06"],
            [9006, 108, "Galaxy S26", 4199, "PENDING", "2026-10-09"],
            [9007, 101, "Roaming Pack", 199, "DELIVERED", "2026-10-11"],
            [9008, 103, "Business Line", 350, "FAILED", "2026-10-12"]
        ])
    });

    // Small per-environment differences so switching environments visibly changes results.
    const environmentAdjustments = {
        2: (db) => {
            db.customers.rows.find((row) => row.customer_id === 103).status = "ACTIVE";
            db.customers.rows.push({ customer_id: 109, customer_name: "Reem", msisdn: "966509012345", city: "Abha", status: "ACTIVE", segment: "Consumer" });
            db.orders.rows.find((row) => row.order_id === 9002).status = "DELIVERED";
        },
        3: (db) => {
            db.orders.rows.push({ order_id: 9009, customer_id: 106, product: "Win-back Offer", amount: 99, status: "PENDING", created_at: "2026-10-14" });
        },
        4: (db) => {
            db.orders.rows = db.orders.rows.slice(0, 4);
        }
    };

    const buildTargetDatabase = (envId) => {
        const db = targetDatabaseTemplate();
        environmentAdjustments[envId]?.(db);
        return db;
    };

    const createSeed = () => {
        const targetDatabases = {};
        environments.forEach((environment) => {
            targetDatabases[environment.envId] = buildTargetDatabase(environment.envId);
        });

        return JSON.parse(JSON.stringify({
            users,
            environments,
            sqlDefinitions,
            userAllowedEnv,
            userAllowedSql,
            executionHistory,
            targetDatabases
        }));
    };

    global.QaLiteMockData = {
        DATABASE_TYPES,
        createSeed,
        createTargetDatabase: () => JSON.parse(JSON.stringify(targetDatabaseTemplate()))
    };
})(window);
