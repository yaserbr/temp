/*
 * Frontend-only replacement for the QA Lite backend (Spring controllers + services).
 *
 *   QaLite.auth       - demo login / logout / registration / page guards (was Spring Security)
 *   QaLite.dashboard  - environments + SQL blocks for the signed-in user (was DashboardService)
 *   QaLite.admin      - environment / SQL / permission CRUD (was AdminService + AdminController)
 *   QaLite.execution  - POST /execute equivalent, runs SQL on the mock target DB (was ExecutionService)
 *   QaLite.flash      - one-shot messages across page loads (was Spring flash attributes)
 *
 * All state lives in localStorage (key "qalite.demo.db.v1"), so changes survive refreshes.
 * Call QaLite.resetDemoData() from the browser console to restore the seed data.
 */
(function (global) {
    "use strict";

    const DB_KEY = "qalite.demo.db.v1";
    const SESSION_KEY = "qalite.demo.session";
    const FLASH_KEY = "qalite.demo.flash";
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
    const TONES = ["is-blue", "is-green", "is-amber"];
    const MAX_PERMISSION_IDS = 500;
    const MAX_ERROR_MESSAGE_LENGTH = 2000;

    /* ------------------------------------------------------------------ storage */

    const memoryStorage = {};

    const storageArea = (area) => (area === "session" ? global.sessionStorage : global.localStorage);

    const readItem = (key, area = "local") => {
        try {
            return storageArea(area).getItem(key);
        } catch (error) {
            return memoryStorage[`${area}:${key}`] ?? null;
        }
    };

    const writeItem = (key, value, area = "local") => {
        try {
            storageArea(area).setItem(key, value);
        } catch (error) {
            memoryStorage[`${area}:${key}`] = value;
        }
    };

    const removeItem = (key, area = "local") => {
        try {
            storageArea(area).removeItem(key);
        } catch (error) {
            delete memoryStorage[`${area}:${key}`];
        }
    };

    const loadDb = () => {
        try {
            const stored = JSON.parse(readItem(DB_KEY));
            if (stored && Array.isArray(stored.users) && stored.targetDatabases) {
                return stored;
            }
        } catch (error) {
            // Corrupt or missing data falls through to a fresh seed.
        }
        const seed = global.QaLiteMockData.createSeed();
        saveDb(seed);
        return seed;
    };

    const saveDb = (db) => writeItem(DB_KEY, JSON.stringify(db));

    const nextId = (rows, field) => rows.reduce((max, row) => Math.max(max, row[field]), 0) + 1;

    const byText = (field) => (a, b) => (a[field] < b[field] ? -1 : (a[field] > b[field] ? 1 : 0));

    const delay = (min, max = min) => new Promise((resolve) => {
        global.setTimeout(resolve, min + Math.random() * (max - min));
    });

    const hasText = (value) => typeof value === "string" && value.trim() !== "";

    const required = (value, fieldName, maxLength) => {
        if (!hasText(value)) {
            throw new Error(`${fieldName} is required`);
        }
        const normalized = value.trim();
        if (maxLength && normalized.length > maxLength) {
            throw new Error(`${fieldName} is too long`);
        }
        return normalized;
    };

    const optional = (value, maxLength) => {
        if (!hasText(value)) {
            return null;
        }
        const normalized = value.trim();
        if (normalized.length > maxLength) {
            throw new Error("Value is too long");
        }
        return normalized;
    };

    /* ------------------------------------------------------------------ password hashing */

    // Compact synchronous SHA-256 so demo passwords are never kept in plain text, and so it also
    // works where crypto.subtle is unavailable (e.g. plain http:// on a LAN address).
    const sha256 = (message) => {
        const k = [];
        const h = [];
        let candidate = 2;
        while (k.length < 64) {
            let prime = true;
            for (let factor = 2; factor * factor <= candidate; factor++) {
                if (candidate % factor === 0) {
                    prime = false;
                    break;
                }
            }
            if (prime) {
                if (h.length < 8) {
                    h.push((Math.pow(candidate, 1 / 2) * 2 ** 32) | 0);
                }
                k.push((Math.pow(candidate, 1 / 3) * 2 ** 32) | 0);
            }
            candidate++;
        }

        const bytes = Array.from(new TextEncoder().encode(message));
        const bitLength = bytes.length * 8;
        bytes.push(0x80);
        while (bytes.length % 64 !== 56) {
            bytes.push(0);
        }
        for (let shift = 56; shift >= 0; shift -= 8) {
            bytes.push(shift >= 32 ? Math.floor(bitLength / 2 ** shift) & 0xff : (bitLength >>> shift) & 0xff);
        }

        const rotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
        const w = new Array(64);

        for (let offset = 0; offset < bytes.length; offset += 64) {
            for (let i = 0; i < 16; i++) {
                const j = offset + i * 4;
                w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
            }
            for (let i = 16; i < 64; i++) {
                const s0 = rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
                const s1 = rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
            }

            let [a, b, c, d, e, f, g, hh] = h;
            for (let i = 0; i < 64; i++) {
                const t1 = (hh + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0;
                const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
                hh = g;
                g = f;
                f = e;
                e = (d + t1) | 0;
                d = c;
                c = b;
                b = a;
                a = (t1 + t2) | 0;
            }
            [a, b, c, d, e, f, g, hh].forEach((value, index) => {
                h[index] = (h[index] + value) | 0;
            });
        }

        return h.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
    };

    const hashPassword = (password) => sha256(`qalite-demo:${password}`);

    /* ------------------------------------------------------------------ session / auth */

    const readSession = () => {
        try {
            return JSON.parse(readItem(SESSION_KEY));
        } catch (error) {
            return null;
        }
    };

    const writeSession = (username) => writeItem(SESSION_KEY, JSON.stringify({
        username,
        expiresAt: Date.now() + SESSION_TIMEOUT_MS
    }));

    const currentUser = () => {
        const session = readSession();
        if (!session || session.expiresAt < Date.now()) {
            removeItem(SESSION_KEY);
            return null;
        }
        const user = loadDb().users.find((candidate) => candidate.username === session.username);
        if (!user) {
            removeItem(SESSION_KEY);
            return null;
        }
        writeSession(user.username);
        return user;
    };

    const isAdmin = (user) => user?.role === "ADMIN";

    const auth = {
        currentUser,

        /** Redirects away (and returns null) when the current visitor may not see this page. */
        guard(requiredRole) {
            const user = currentUser();
            if (!user) {
                global.location.replace("login.html");
                return null;
            }
            if (requiredRole === "ADMIN" && !isAdmin(user)) {
                global.location.replace("index.html");
                return null;
            }
            return user;
        },

        async login(username, password) {
            await delay(450, 750);
            const user = loadDb().users.find((candidate) => candidate.username === username);
            if (!user || !password || user.passwordHash !== hashPassword(password)) {
                return false;
            }
            writeSession(user.username);
            return true;
        },

        async logout() {
            await delay(120);
            removeItem(SESSION_KEY);
        },

        /** Same rules as RegistrationService; throws an Error with a user-facing message. */
        async register(username, password) {
            await delay(300, 500);
            const normalizedUsername = required(username, "Username");
            const rawPassword = required(password, "Password");

            if (normalizedUsername.length < 3 || normalizedUsername.length > 100) {
                throw new Error("Username must be between 3 and 100 characters");
            }
            if (!/^[A-Za-z0-9._-]+$/.test(normalizedUsername)) {
                throw new Error("Username can contain letters, numbers, dots, underscores, and hyphens only");
            }
            if (rawPassword.length < 8 || rawPassword.length > 128) {
                throw new Error("Password must be between 8 and 128 characters");
            }

            const db = loadDb();
            if (db.users.some((user) => user.username === normalizedUsername)) {
                throw new Error("Username already exists");
            }

            db.users.push({
                userId: nextId(db.users, "userId"),
                username: normalizedUsername,
                passwordHash: hashPassword(rawPassword),
                role: "QA_USER",
                createdAt: new Date().toISOString()
            });
            saveDb(db);
            return normalizedUsername;
        }
    };

    /* ------------------------------------------------------------------ flash messages */

    const flash = {
        set(page, type, message) {
            writeItem(FLASH_KEY, JSON.stringify({ page, type, message }), "session");
        },

        take(page) {
            try {
                const stored = JSON.parse(readItem(FLASH_KEY, "session"));
                if (stored?.page === page) {
                    removeItem(FLASH_KEY, "session");
                    return stored;
                }
            } catch (error) {
                removeItem(FLASH_KEY, "session");
            }
            return null;
        }
    };

    /* ------------------------------------------------------------------ dashboard */

    const environmentNote = (environment) => (hasText(environment.description) ? environment.description.trim() : environment.dbType);

    const allowedIds = (rows, userId, field) => new Set(rows.filter((row) => row.userId === userId).map((row) => row[field]));

    const dashboard = {
        getView() {
            const user = currentUser();
            const db = loadDb();
            const admin = isAdmin(user);
            const envIds = allowedIds(db.userAllowedEnv, user?.userId, "envId");
            const sqlIds = allowedIds(db.userAllowedSql, user?.userId, "sqlId");

            const environments = db.environments
                .filter((environment) => admin || envIds.has(environment.envId))
                .sort(byText("name"))
                .map((environment) => ({ envId: environment.envId, name: environment.name, note: environmentNote(environment) }));

            const sqlCommands = db.sqlDefinitions
                .filter((sql) => admin || sqlIds.has(sql.sqlId))
                .sort(byText("sqlName"))
                .map((sql, index) => ({
                    sqlId: sql.sqlId,
                    commandId: `sql-${sql.sqlId}`,
                    sqlName: sql.sqlName,
                    sqlDescription: sql.sqlDescription,
                    tone: TONES[index % TONES.length],
                    parameterNames: global.QaLiteSqlEngine
                        ? global.QaLiteSqlEngine.extractParameterNames(sql.sqlText)
                        : []
                }));

            return {
                isAdmin: admin,
                environments,
                sqlCommands,
                activeEnvironment: environments[0] ?? null,
                activeCommand: sqlCommands[0] ?? null
            };
        }
    };

    /* ------------------------------------------------------------------ admin */

    const findDatabaseType = (value) => global.QaLiteMockData.DATABASE_TYPES
        .find((type) => type.value.toLowerCase() === String(value ?? "").toLowerCase());

    const validateJdbcUrl = (databaseType, jdbcUrl) => {
        if (!jdbcUrl.toLowerCase().startsWith(databaseType.jdbcPrefix)) {
            throw new Error(`${databaseType.label} JDBC URL must start with ${databaseType.jdbcPrefix}`);
        }
        if (databaseType.value === "MONGODB_ATLAS_SQL") {
            const path = jdbcUrl.slice("jdbc:mongodb://".length).split(/[?#]/)[0];
            const slash = path.indexOf("/");
            if (slash === -1 || path.slice(slash + 1) === "") {
                throw new Error("MongoDB Atlas SQL JDBC URL must include a database name");
            }
        }

        const normalized = jdbcUrl.toLowerCase();
        if (/[?&;](user|username|password)=/.test(normalized)) {
            throw new Error("Put database credentials in the username and password fields, not in the JDBC URL");
        }
        if (normalized.startsWith("jdbc:mongodb://") && jdbcUrl.slice("jdbc:mongodb://".length).split("/", 1)[0].includes("@")) {
            throw new Error("Put MongoDB Atlas credentials in the username and password fields, not in the JDBC URL");
        }
    };

    const requireAdmin = () => {
        const user = currentUser();
        if (!isAdmin(user)) {
            throw new Error("Access denied");
        }
        return user;
    };

    const admin = {
        databaseTypes: () => global.QaLiteMockData.DATABASE_TYPES.map(({ value, label }) => ({ value, label })),

        getView() {
            const db = loadDb();
            return {
                users: db.users
                    .filter((user) => user.role !== "ADMIN")
                    .sort(byText("username"))
                    .map((user) => ({
                        userId: user.userId,
                        username: user.username,
                        role: user.role,
                        environmentIds: allowedIds(db.userAllowedEnv, user.userId, "envId"),
                        sqlIds: allowedIds(db.userAllowedSql, user.userId, "sqlId")
                    })),
                environments: db.environments.slice().sort(byText("name")).map((environment) => ({
                    envId: environment.envId,
                    name: environment.name,
                    description: environment.description,
                    dbType: environment.dbType,
                    jdbcUrl: environment.jdbcUrl,
                    dbUsername: environment.dbUsername
                })),
                sqlDefinitions: db.sqlDefinitions.slice().sort(byText("sqlName")),
                databaseTypes: admin.databaseTypes()
            };
        },

        async createEnvironment({ name, description, dbType, jdbcUrl, dbUsername, dbPasswordValue }) {
            requireAdmin();
            await delay(200);
            const databaseType = findDatabaseType(dbType);
            if (!databaseType) {
                throw new Error("Unsupported database type");
            }
            const normalizedJdbcUrl = required(jdbcUrl, "JDBC URL", 1000);
            validateJdbcUrl(databaseType, normalizedJdbcUrl);

            const environment = {
                name: required(name, "Environment name", 100),
                description: optional(description, 500),
                dbType: databaseType.value,
                jdbcUrl: normalizedJdbcUrl,
                dbUsername: required(dbUsername, "Database username", 200)
            };
            // Validated like the original, but never stored: the demo has no real database to log into.
            required(dbPasswordValue, "Database password value");

            const db = loadDb();
            if (db.environments.some((existing) => existing.name === environment.name)) {
                throw new Error("A record with the same name already exists.");
            }
            environment.envId = nextId(db.environments, "envId");
            db.environments.push(environment);
            db.targetDatabases[environment.envId] = global.QaLiteMockData.createTargetDatabase();
            saveDb(db);
        },

        async createSqlDefinition({ sqlName, sqlDescription, sqlText }) {
            requireAdmin();
            await delay(200);
            const definition = {
                sqlText: required(sqlText, "SQL text", 20000),
                sqlName: required(sqlName, "SQL command name", 200),
                sqlDescription: optional(sqlDescription, 1000)
            };

            const db = loadDb();
            if (db.sqlDefinitions.some((existing) => existing.sqlName === definition.sqlName)) {
                throw new Error("A record with the same name already exists.");
            }
            definition.sqlId = nextId(db.sqlDefinitions, "sqlId");
            db.sqlDefinitions.push({
                sqlId: definition.sqlId,
                sqlName: definition.sqlName,
                sqlDescription: definition.sqlDescription,
                sqlText: definition.sqlText
            });
            saveDb(db);
        },

        async deleteEnvironment(envId) {
            requireAdmin();
            await delay(150);
            const db = loadDb();
            if (!db.environments.some((environment) => environment.envId === envId)) {
                throw new Error("Environment does not exist");
            }
            db.executionHistory = db.executionHistory.filter((entry) => entry.envId !== envId);
            db.userAllowedEnv = db.userAllowedEnv.filter((entry) => entry.envId !== envId);
            db.environments = db.environments.filter((environment) => environment.envId !== envId);
            delete db.targetDatabases[envId];
            saveDb(db);
        },

        async deleteSqlDefinition(sqlId) {
            requireAdmin();
            await delay(150);
            const db = loadDb();
            if (!db.sqlDefinitions.some((sql) => sql.sqlId === sqlId)) {
                throw new Error("SQL command does not exist");
            }
            db.executionHistory = db.executionHistory.filter((entry) => entry.sqlId !== sqlId);
            db.userAllowedSql = db.userAllowedSql.filter((entry) => entry.sqlId !== sqlId);
            db.sqlDefinitions = db.sqlDefinitions.filter((sql) => sql.sqlId !== sqlId);
            saveDb(db);
        },

        async deleteUser(userId) {
            const actingUser = requireAdmin();
            await delay(150);
            const db = loadDb();
            const user = db.users.find((candidate) => candidate.userId === userId);
            if (!user) {
                throw new Error("User does not exist");
            }
            if (user.username === actingUser.username) {
                throw new Error("You cannot delete your own account");
            }
            if (user.role === "ADMIN" && db.users.filter((candidate) => candidate.role === "ADMIN").length <= 1) {
                throw new Error("Cannot delete the last remaining admin account");
            }
            db.executionHistory = db.executionHistory.filter((entry) => entry.userId !== userId);
            db.userAllowedEnv = db.userAllowedEnv.filter((entry) => entry.userId !== userId);
            db.userAllowedSql = db.userAllowedSql.filter((entry) => entry.userId !== userId);
            db.users = db.users.filter((candidate) => candidate.userId !== userId);
            saveDb(db);
        },

        async updateUserPermissions(userId, environmentIds, sqlIds) {
            requireAdmin();
            await delay(150);
            const db = loadDb();
            const user = db.users.find((candidate) => candidate.userId === userId);
            if (!user) {
                throw new Error("User does not exist");
            }
            if (user.role === "ADMIN") {
                throw new Error("Admin users automatically have full access");
            }
            if (environmentIds.length > MAX_PERMISSION_IDS) {
                throw new Error("Environment permissions exceeded the allowed limit");
            }
            if (sqlIds.length > MAX_PERMISSION_IDS) {
                throw new Error("SQL permissions exceeded the allowed limit");
            }

            const uniqueEnvIds = [...new Set(environmentIds)];
            const uniqueSqlIds = [...new Set(sqlIds)];
            const validSelection = uniqueEnvIds.every((id) => db.environments.some((environment) => environment.envId === id))
                && uniqueSqlIds.every((id) => db.sqlDefinitions.some((sql) => sql.sqlId === id));
            if (!validSelection) {
                throw new Error("Invalid selection, or this record is still referenced by other data (e.g. execution history).");
            }

            db.userAllowedEnv = db.userAllowedEnv
                .filter((entry) => entry.userId !== userId)
                .concat(uniqueEnvIds.map((envId) => ({ userId, envId })));
            db.userAllowedSql = db.userAllowedSql
                .filter((entry) => entry.userId !== userId)
                .concat(uniqueSqlIds.map((sqlId) => ({ userId, sqlId })));
            saveDb(db);
        },

        /** Simulated: there is no real database to reach, so this only checks the record exists. */
        async testConnection(envId) {
            requireAdmin();
            await delay(600, 900);
            const db = loadDb();
            if (!db.environments.some((environment) => environment.envId === envId)) {
                throw new Error("Environment does not exist");
            }
            return true;
        }
    };

    /* ------------------------------------------------------------------ execution */

    const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" }
    });

    const truncate = (value, maxLength) => (value && value.length > maxLength ? value.slice(0, maxLength) : value);

    const execution = {
        /** Equivalent of POST /execute: resolves to a Response with the original JSON shape. */
        async execute({ environmentId, sqlId, parameters }) {
            await delay(350, 800);
            const user = currentUser();
            if (!user) {
                return jsonResponse(401, { message: "Your session has expired. Please sign in again." });
            }

            const db = loadDb();
            const admin = isAdmin(user);
            if (!admin && !db.userAllowedEnv.some((entry) => entry.userId === user.userId && entry.envId === environmentId)) {
                return jsonResponse(403, { message: "This environment is not allowed for your account" });
            }
            if (!admin && !db.userAllowedSql.some((entry) => entry.userId === user.userId && entry.sqlId === sqlId)) {
                return jsonResponse(403, { message: "This SQL command is not allowed for your account" });
            }

            const sql = db.sqlDefinitions.find((candidate) => candidate.sqlId === sqlId);
            if (!sql) {
                return jsonResponse(400, { message: "SQL command does not exist" });
            }
            const environment = db.environments.find((candidate) => candidate.envId === environmentId);
            if (!environment) {
                return jsonResponse(400, { message: "Environment does not exist" });
            }

            const tables = db.targetDatabases[environmentId] ?? (db.targetDatabases[environmentId] = global.QaLiteMockData.createTargetDatabase());
            const history = {
                executionId: nextId(db.executionHistory, "executionId"),
                userId: user.userId,
                envId: environmentId,
                sqlId,
                startedAt: new Date().toISOString(),
                clientIp: "127.0.0.1"
            };

            try {
                const outcome = global.QaLiteSqlEngine.execute(sql.sqlText, parameters ?? {}, tables);
                db.executionHistory.push({ ...history, status: "SUCCESS", recordsReturned: outcome.recordsReturned, rowsAffected: outcome.rowsAffected, errorMessage: null });
                saveDb(db);
                return jsonResponse(200, {
                    success: true,
                    environmentName: environment.name,
                    columns: outcome.columns,
                    rows: outcome.rows,
                    rowsAffected: outcome.rowsAffected,
                    errorMessage: null
                });
            } catch (error) {
                const description = truncate(`${error.name}: ${error.message}`, MAX_ERROR_MESSAGE_LENGTH);
                // Statements that ran before the failing one stay applied, like auto-commit JDBC.
                db.executionHistory.push({ ...history, status: "FAILED", recordsReturned: null, rowsAffected: null, errorMessage: description });
                saveDb(db);
                return jsonResponse(200, {
                    success: false,
                    environmentName: environment.name,
                    columns: [],
                    rows: [],
                    rowsAffected: null,
                    errorMessage: admin
                        ? description
                        : "The command failed against the target database. Please check with an administrator."
                });
            }
        }
    };

    global.QaLite = {
        auth,
        flash,
        dashboard,
        admin,
        execution,
        resetDemoData() {
            removeItem(DB_KEY);
            removeItem(SESSION_KEY);
            removeItem(FLASH_KEY, "session");
            loadDb();
            return "QA Lite demo data restored. Reload the page.";
        }
    };
})(window);
