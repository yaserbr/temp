/*
 * A small in-browser SQL interpreter that stands in for the real target databases in the
 * frontend-only demo. It runs admin-defined SQL against the mock tables in mock-data.js.
 *
 * Supported:
 *   SELECT [DISTINCT] ... [FROM t [alias] [[INNER|LEFT] JOIN t2 ON ...]] [WHERE] [GROUP BY] [HAVING]
 *          [UNION [ALL] ...] [ORDER BY] [LIMIT/OFFSET | FETCH FIRST n ROWS ONLY]
 *   INSERT INTO ... VALUES (...) | SELECT ...      UPDATE ... SET ... [WHERE]      DELETE FROM ... [WHERE]
 *   CREATE TABLE [IF NOT EXISTS] ... (...) | AS SELECT      DROP TABLE [IF EXISTS]      TRUNCATE TABLE
 *   Expressions: arithmetic, ||, comparisons, LIKE, IN, BETWEEN, IS [NOT] NULL, CASE, CAST, ::casts,
 *   common scalar functions and COUNT/SUM/AVG/MIN/MAX.
 *
 * Anything else fails with a clear "not supported in the browser-only demo" error instead of
 * pretending to succeed. Named parameters (":name") follow the same rules as the original
 * SqlParameterParser: not inside quotes/comments, and "::" is a cast, not a parameter.
 */
(function (global) {
    "use strict";

    const MAX_ROWS = 500;

    class MockSqlError extends Error {
        constructor(message) {
            super(message);
            this.name = "MockSqlException";
        }
    }

    const fail = (message) => {
        throw new MockSqlError(message);
    };

    const unsupported = (feature) => fail(`${feature} is not supported by the browser-only demo database`);

    /* ------------------------------------------------------------------ tokenizer */

    const isNameStart = (c) => c !== undefined && /[\p{L}_]/u.test(c);
    const isNameChar = (c) => c !== undefined && /[\p{L}\p{N}_$]/u.test(c);

    const tokenize = (sql) => {
        const tokens = [];
        const length = sql.length;
        let i = 0;

        const push = (type, value, start) => tokens.push({ type, value, upper: String(value).toUpperCase(), pos: start });

        while (i < length) {
            const c = sql[i];

            if (/\s/.test(c)) {
                i++;
                continue;
            }

            if ((c === "-" && sql[i + 1] === "-") || c === "#") {
                const end = sql.indexOf("\n", i);
                i = end === -1 ? length : end;
                continue;
            }

            if (c === "/" && sql[i + 1] === "*") {
                const end = sql.indexOf("*/", i + 2);
                i = end === -1 ? length : end + 2;
                continue;
            }

            if (c === "'" || c === '"' || c === "`") {
                const start = i;
                let value = "";
                i++;
                while (i < length) {
                    const ch = sql[i];
                    if (c !== "`" && ch === "\\" && sql[i + 1] === c) {
                        value += c;
                        i += 2;
                        continue;
                    }
                    if (ch === c) {
                        if (sql[i + 1] === c) {
                            value += c;
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    value += ch;
                    i++;
                }
                i++;
                push(c === "'" ? "string" : "qident", value, start);
                continue;
            }

            if (c === "$") {
                const match = /^\$([\p{L}\p{N}_]*)\$/u.exec(sql.slice(i));
                if (match) {
                    const tag = match[0];
                    const bodyStart = i + tag.length;
                    const closing = sql.indexOf(tag, bodyStart);
                    const bodyEnd = closing === -1 ? length : closing;
                    push("string", sql.slice(bodyStart, bodyEnd), i);
                    i = closing === -1 ? length : closing + tag.length;
                    continue;
                }
            }

            if (c === ":") {
                if (sql[i + 1] === ":") {
                    push("op", "::", i);
                    i += 2;
                    continue;
                }
                if (isNameStart(sql[i + 1])) {
                    const start = i;
                    let end = i + 2;
                    while (end < length && isNameChar(sql[end]) && sql[end] !== "$") {
                        end++;
                    }
                    push("param", sql.slice(start + 1, end), start);
                    i = end;
                    continue;
                }
            }

            if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
                const match = /^(\d*\.?\d+(?:[eE][+-]?\d+)?|\d+\.)/.exec(sql.slice(i));
                push("number", Number(match[0]), i);
                i += match[0].length;
                continue;
            }

            if (isNameStart(c)) {
                const start = i;
                i++;
                while (i < length && isNameChar(sql[i])) {
                    i++;
                }
                push("ident", sql.slice(start, i), start);
                continue;
            }

            const twoChar = sql.slice(i, i + 2);
            if (["<=", ">=", "<>", "!=", "||"].includes(twoChar)) {
                push("op", twoChar, i);
                i += 2;
                continue;
            }

            if ("=<>+-*/%".includes(c)) {
                push("op", c, i);
                i++;
                continue;
            }

            push("punct", c, i);
            i++;
        }

        return tokens;
    };

    const extractParameterNames = (sql) => {
        const names = [];
        tokenize(String(sql ?? "")).forEach((token) => {
            if (token.type === "param" && !names.includes(token.value)) {
                names.push(token.value);
            }
        });
        return names;
    };

    const splitStatements = (tokens) => {
        const statements = [[]];
        tokens.forEach((token) => {
            if (token.type === "punct" && token.value === ";") {
                statements.push([]);
            } else {
                statements[statements.length - 1].push(token);
            }
        });
        return statements.filter((statement) => statement.length > 0);
    };

    /* ------------------------------------------------------------------ parser */

    const RESERVED = new Set([
        "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "LIMIT", "OFFSET", "FETCH", "UNION",
        "ALL", "DISTINCT", "AS", "ON", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "AND",
        "OR", "NOT", "IN", "IS", "NULL", "LIKE", "ILIKE", "BETWEEN", "CASE", "WHEN", "THEN", "ELSE", "END",
        "ASC", "DESC", "VALUES", "SET", "INTO", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "TABLE",
        "EXISTS", "WITH", "NATURAL", "USING", "INTERSECT", "EXCEPT", "MINUS", "RETURNING", "NULLS"
    ]);

    const AGGREGATES = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);

    class Parser {
        constructor(tokens) {
            this.tokens = tokens;
            this.index = 0;
        }

        peek(offset = 0) {
            return this.tokens[this.index + offset];
        }

        next() {
            return this.tokens[this.index++];
        }

        atEnd() {
            return this.index >= this.tokens.length;
        }

        isWord(word, offset = 0) {
            const token = this.peek(offset);
            return token?.type === "ident" && token.upper === word;
        }

        isPunct(value, offset = 0) {
            const token = this.peek(offset);
            return token?.type === "punct" && token.value === value;
        }

        isOp(value, offset = 0) {
            const token = this.peek(offset);
            return token?.type === "op" && token.value === value;
        }

        acceptWord(...words) {
            if (words.every((word, offset) => this.isWord(word, offset))) {
                this.index += words.length;
                return true;
            }
            return false;
        }

        acceptPunct(value) {
            if (this.isPunct(value)) {
                this.index++;
                return true;
            }
            return false;
        }

        acceptOp(value) {
            if (this.isOp(value)) {
                this.index++;
                return true;
            }
            return false;
        }

        syntaxError() {
            const token = this.peek();
            return fail(token ? `syntax error at or near "${token.value}"` : "syntax error at end of input");
        }

        expectWord(word) {
            if (!this.acceptWord(word)) {
                this.syntaxError();
            }
        }

        expectPunct(value) {
            if (!this.acceptPunct(value)) {
                this.syntaxError();
            }
        }

        identifier() {
            const token = this.peek();
            if (token?.type === "qident") {
                this.index++;
                return token.value;
            }
            if (token?.type === "ident" && !RESERVED.has(token.upper)) {
                this.index++;
                return token.value.toLowerCase();
            }
            return this.syntaxError();
        }

        tableName() {
            let name = this.identifier();
            // schema.table - the schema is ignored, every environment has a single schema.
            while (this.acceptPunct(".")) {
                name = this.identifier();
            }
            return name;
        }

        optionalAlias() {
            if (this.acceptWord("AS")) {
                return this.identifier();
            }
            const token = this.peek();
            if (token?.type === "qident" || (token?.type === "ident" && !RESERVED.has(token.upper))) {
                return this.identifier();
            }
            return null;
        }

        parseStatement() {
            const first = this.peek();
            if (this.isPunct("(") || this.isWord("SELECT")) {
                return this.finish(this.parseQuery());
            }
            if (first?.type !== "ident") {
                return this.syntaxError();
            }

            switch (first.upper) {
                case "INSERT": return this.finish(this.parseInsert());
                case "UPDATE": return this.finish(this.parseUpdate());
                case "DELETE": return this.finish(this.parseDelete());
                case "CREATE": return this.finish(this.parseCreate());
                case "DROP": return this.finish(this.parseDrop());
                case "TRUNCATE": return this.finish(this.parseTruncate());
                case "COMMIT":
                case "ROLLBACK":
                case "BEGIN":
                case "START":
                case "SET":
                    this.index = this.tokens.length;
                    return { type: "noop" };
                case "WITH": return unsupported("WITH (common table expressions)");
                default: return unsupported(`${first.upper} statements`);
            }
        }

        finish(statement) {
            if (!this.atEnd()) {
                this.syntaxError();
            }
            return statement;
        }

        /* ---- SELECT ---- */

        parseQuery() {
            const cores = [this.parseSelectCore()];
            const unions = [];

            while (this.isWord("UNION") || this.isWord("INTERSECT") || this.isWord("EXCEPT") || this.isWord("MINUS")) {
                if (!this.isWord("UNION")) {
                    unsupported(this.peek().upper);
                }
                this.next();
                unions.push(this.acceptWord("ALL") ? "ALL" : (this.acceptWord("DISTINCT"), "DISTINCT"));
                cores.push(this.parseSelectCore());
            }

            const query = { type: "select", cores, unions, orderBy: [], limit: null, offset: null };

            if (this.acceptWord("ORDER", "BY")) {
                do {
                    const expr = this.parseExpression();
                    let descending = false;
                    if (this.acceptWord("DESC")) {
                        descending = true;
                    } else {
                        this.acceptWord("ASC");
                    }
                    let nullsFirst = descending;
                    if (this.acceptWord("NULLS")) {
                        if (this.acceptWord("FIRST")) {
                            nullsFirst = true;
                        } else {
                            this.expectWord("LAST");
                            nullsFirst = false;
                        }
                    }
                    query.orderBy.push({ expr, descending, nullsFirst });
                } while (this.acceptPunct(","));
            }

            this.parseLimit(query);
            return query;
        }

        parseLimit(query) {
            if (this.acceptWord("LIMIT")) {
                const first = this.parseExpression();
                if (this.acceptPunct(",")) {
                    query.offset = first;
                    query.limit = this.parseExpression();
                } else {
                    query.limit = first;
                }
            }
            if (this.acceptWord("OFFSET")) {
                query.offset = this.parseExpression();
                this.acceptWord("ROWS") || this.acceptWord("ROW");
            }
            if (this.acceptWord("FETCH")) {
                if (!this.acceptWord("FIRST")) {
                    this.expectWord("NEXT");
                }
                query.limit = this.isWord("ROWS") || this.isWord("ROW")
                    ? { type: "literal", value: 1 }
                    : this.parseExpression();
                this.acceptWord("ROWS") || this.acceptWord("ROW");
                this.expectWord("ONLY");
            }
        }

        parseSelectCore() {
            if (this.acceptPunct("(")) {
                const inner = this.parseQuery();
                this.expectPunct(")");
                if (inner.cores.length !== 1 || inner.orderBy.length || inner.limit) {
                    unsupported("Parenthesized compound queries");
                }
                return inner.cores[0];
            }

            this.expectWord("SELECT");
            const core = { distinct: false, items: [], from: null, joins: [], where: null, groupBy: [], having: null };

            if (this.acceptWord("DISTINCT")) {
                core.distinct = true;
            } else {
                this.acceptWord("ALL");
            }

            do {
                core.items.push(this.parseSelectItem());
            } while (this.acceptPunct(","));

            if (this.acceptWord("FROM")) {
                core.from = this.parseTableRef();
                for (;;) {
                    if (this.acceptPunct(",")) {
                        core.joins.push({ kind: "CROSS", table: this.parseTableRef(), on: null });
                        continue;
                    }
                    let kind = null;
                    if (this.acceptWord("JOIN") || this.acceptWord("INNER", "JOIN")) {
                        kind = "INNER";
                    } else if (this.acceptWord("LEFT", "JOIN") || this.acceptWord("LEFT", "OUTER", "JOIN")) {
                        kind = "LEFT";
                    } else if (this.acceptWord("CROSS", "JOIN")) {
                        kind = "CROSS";
                    } else if (this.isWord("RIGHT") || this.isWord("FULL") || this.isWord("NATURAL")) {
                        unsupported(`${this.peek().upper} JOIN`);
                    }
                    if (!kind) {
                        break;
                    }
                    const tableRef = this.parseTableRef();
                    let on = null;
                    if (kind !== "CROSS") {
                        if (this.isWord("USING")) {
                            unsupported("JOIN ... USING");
                        }
                        this.expectWord("ON");
                        on = this.parseExpression();
                    }
                    core.joins.push({ kind, table: tableRef, on });
                }
            }

            if (this.acceptWord("WHERE")) {
                core.where = this.parseExpression();
            }

            if (this.acceptWord("GROUP", "BY")) {
                do {
                    core.groupBy.push(this.parseExpression());
                } while (this.acceptPunct(","));
            }

            if (this.acceptWord("HAVING")) {
                core.having = this.parseExpression();
            }

            return core;
        }

        parseTableRef() {
            if (this.isPunct("(")) {
                unsupported("Subqueries in FROM");
            }
            const name = this.tableName();
            const alias = this.optionalAlias();
            return { name, alias: alias || name };
        }

        parseSelectItem() {
            if (this.acceptOp("*")) {
                return { star: true };
            }
            const token = this.peek();
            if ((token?.type === "ident" || token?.type === "qident") && this.isPunct(".", 1) && this.isOp("*", 2)) {
                const table = this.identifier();
                this.index += 2;
                return { star: true, table };
            }

            const start = this.index;
            const expr = this.parseExpression();
            const alias = this.optionalAlias();
            return { expr, alias, label: alias || defaultLabel(expr, this.tokens.slice(start, this.index)) };
        }

        /* ---- DML / DDL ---- */

        parseInsert() {
            this.expectWord("INSERT");
            this.expectWord("INTO");
            const table = this.tableName();
            let columns = null;

            if (this.isPunct("(") && !this.isWord("SELECT", 1)) {
                this.next();
                columns = [];
                do {
                    columns.push(this.identifier());
                } while (this.acceptPunct(","));
                this.expectPunct(")");
            }

            if (this.acceptWord("VALUES")) {
                const rows = [];
                do {
                    this.expectPunct("(");
                    const values = [];
                    do {
                        values.push(this.parseExpression());
                    } while (this.acceptPunct(","));
                    this.expectPunct(")");
                    rows.push(values);
                } while (this.acceptPunct(","));
                return { type: "insert", table, columns, rows };
            }

            return { type: "insert", table, columns, query: this.parseQuery() };
        }

        parseUpdate() {
            this.expectWord("UPDATE");
            const table = this.tableName();
            const alias = this.isWord("SET") ? null : this.optionalAlias();
            this.expectWord("SET");

            const assignments = [];
            do {
                let column = this.identifier();
                if (this.acceptPunct(".")) {
                    column = this.identifier();
                }
                if (!this.acceptOp("=")) {
                    this.syntaxError();
                }
                assignments.push({ column, expr: this.parseExpression() });
            } while (this.acceptPunct(","));

            const where = this.acceptWord("WHERE") ? this.parseExpression() : null;
            return { type: "update", table, alias: alias || table, assignments, where };
        }

        parseDelete() {
            this.expectWord("DELETE");
            this.acceptWord("FROM");
            const table = this.tableName();
            const alias = this.isWord("WHERE") ? null : this.optionalAlias();
            const where = this.acceptWord("WHERE") ? this.parseExpression() : null;
            return { type: "delete", table, alias: alias || table, where };
        }

        parseCreate() {
            this.expectWord("CREATE");
            this.acceptWord("OR", "REPLACE");
            this.acceptWord("GLOBAL");
            this.acceptWord("TEMPORARY") || this.acceptWord("TEMP");

            if (this.acceptWord("INDEX") || this.acceptWord("UNIQUE", "INDEX")) {
                this.index = this.tokens.length;
                return { type: "noop" };
            }

            if (!this.acceptWord("TABLE")) {
                unsupported(`CREATE ${this.peek()?.upper ?? ""}`.trim());
            }

            const ifNotExists = this.acceptWord("IF", "NOT", "EXISTS");
            const table = this.tableName();

            if (this.acceptWord("AS")) {
                return { type: "createAs", table, ifNotExists, query: this.parseQuery() };
            }

            this.expectPunct("(");
            const columns = [];
            let autoIncrement = null;

            for (;;) {
                const isConstraint = ["CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "KEY", "INDEX"]
                    .some((word) => this.isWord(word));
                let name = null;
                const typeWords = [];

                if (!isConstraint) {
                    name = this.identifier();
                }

                let depth = 0;
                while (!this.atEnd()) {
                    if (depth === 0 && (this.isPunct(",") || this.isPunct(")"))) {
                        break;
                    }
                    const token = this.next();
                    if (token.type === "punct" && token.value === "(") {
                        depth++;
                    } else if (token.type === "punct" && token.value === ")") {
                        depth--;
                    } else if (token.type === "ident") {
                        typeWords.push(token.upper);
                    }
                }

                if (name) {
                    const typeName = typeWords[0] || "TEXT";
                    const numeric = /^(INT|INTEGER|SMALLINT|BIGINT|TINYINT|MEDIUMINT|NUMBER|NUMERIC|DECIMAL|DEC|FLOAT|REAL|DOUBLE|SERIAL|BIGSERIAL|SMALLSERIAL|BINARY_FLOAT|BINARY_DOUBLE)$/.test(typeName);
                    columns.push({ name, type: numeric ? "number" : "text" });
                    if (/SERIAL$/.test(typeName) || typeWords.includes("AUTO_INCREMENT") || typeWords.includes("IDENTITY")) {
                        autoIncrement = name;
                    }
                }

                if (this.acceptPunct(",")) {
                    continue;
                }
                this.expectPunct(")");
                break;
            }

            // Trailing table options (ENGINE=..., TABLESPACE ...) are irrelevant here.
            this.index = this.tokens.length;
            return { type: "create", table, ifNotExists, columns, autoIncrement };
        }

        parseDrop() {
            this.expectWord("DROP");
            if (!this.acceptWord("TABLE")) {
                if (this.acceptWord("INDEX")) {
                    this.index = this.tokens.length;
                    return { type: "noop" };
                }
                unsupported(`DROP ${this.peek()?.upper ?? ""}`.trim());
            }
            const ifExists = this.acceptWord("IF", "EXISTS");
            const table = this.tableName();
            this.acceptWord("CASCADE") || this.acceptWord("PURGE") || this.acceptWord("RESTRICT");
            this.acceptWord("CONSTRAINTS");
            return { type: "drop", table, ifExists };
        }

        parseTruncate() {
            this.expectWord("TRUNCATE");
            this.acceptWord("TABLE");
            const table = this.tableName();
            this.index = this.tokens.length;
            return { type: "truncate", table };
        }

        /* ---- expressions ---- */

        parseExpression() {
            return this.parseOr();
        }

        parseOr() {
            let left = this.parseAnd();
            while (this.acceptWord("OR")) {
                left = { type: "or", left, right: this.parseAnd() };
            }
            return left;
        }

        parseAnd() {
            let left = this.parseNot();
            while (this.acceptWord("AND")) {
                left = { type: "and", left, right: this.parseNot() };
            }
            return left;
        }

        parseNot() {
            if (this.acceptWord("NOT")) {
                return { type: "not", operand: this.parseNot() };
            }
            return this.parseComparison();
        }

        parseComparison() {
            const left = this.parseAdditive();

            for (const op of ["=", "<>", "!=", "<", ">", "<=", ">="]) {
                if (this.acceptOp(op)) {
                    return { type: "compare", op: op === "!=" ? "<>" : op, left, right: this.parseAdditive() };
                }
            }

            if (this.acceptWord("IS")) {
                const negated = this.acceptWord("NOT");
                this.expectWord("NULL");
                return { type: "isNull", operand: left, negated };
            }

            const negated = this.acceptWord("NOT");

            if (this.acceptWord("LIKE") || (this.isWord("ILIKE") && this.next())) {
                const caseInsensitive = this.tokens[this.index - 1].upper === "ILIKE";
                return { type: "like", operand: left, pattern: this.parseAdditive(), negated, caseInsensitive };
            }

            if (this.acceptWord("IN")) {
                this.expectPunct("(");
                if (this.isWord("SELECT")) {
                    unsupported("IN (subquery)");
                }
                const values = [];
                do {
                    values.push(this.parseExpression());
                } while (this.acceptPunct(","));
                this.expectPunct(")");
                return { type: "in", operand: left, values, negated };
            }

            if (this.acceptWord("BETWEEN")) {
                const low = this.parseAdditive();
                this.expectWord("AND");
                return { type: "between", operand: left, low, high: this.parseAdditive(), negated };
            }

            if (negated) {
                this.syntaxError();
            }
            return left;
        }

        parseAdditive() {
            let left = this.parseMultiplicative();
            for (;;) {
                const token = this.peek();
                if (token?.type === "op" && ["+", "-", "||"].includes(token.value)) {
                    this.next();
                    left = { type: "binary", op: token.value, left, right: this.parseMultiplicative() };
                } else {
                    return left;
                }
            }
        }

        parseMultiplicative() {
            let left = this.parseUnary();
            for (;;) {
                const token = this.peek();
                if (token?.type === "op" && ["*", "/", "%"].includes(token.value)) {
                    this.next();
                    left = { type: "binary", op: token.value, left, right: this.parseUnary() };
                } else {
                    return left;
                }
            }
        }

        parseUnary() {
            if (this.acceptOp("-")) {
                return { type: "negate", operand: this.parseUnary() };
            }
            if (this.acceptOp("+")) {
                return this.parseUnary();
            }
            return this.parsePostfix();
        }

        parsePostfix() {
            let expr = this.parsePrimary();
            while (this.acceptOp("::")) {
                expr = { type: "cast", operand: expr, target: this.parseTypeName() };
            }
            return expr;
        }

        parseTypeName() {
            const token = this.next();
            if (token?.type !== "ident") {
                this.index--;
                this.syntaxError();
            }
            // Multi-word types such as "double precision" / "character varying".
            while (this.isWord("PRECISION") || this.isWord("VARYING")) {
                this.next();
            }
            if (this.acceptPunct("(")) {
                while (!this.atEnd() && !this.acceptPunct(")")) {
                    this.next();
                }
            }
            return token.upper;
        }

        parsePrimary() {
            const token = this.peek();
            if (!token) {
                return this.syntaxError();
            }

            if (token.type === "number") {
                this.next();
                return { type: "literal", value: token.value };
            }
            if (token.type === "string") {
                this.next();
                return { type: "literal", value: token.value };
            }
            if (token.type === "param") {
                this.next();
                return { type: "param", name: token.value };
            }
            if (token.type === "punct" && token.value === "(") {
                this.next();
                if (this.isWord("SELECT")) {
                    unsupported("Subqueries");
                }
                const expr = this.parseExpression();
                this.expectPunct(")");
                return expr;
            }

            if (token.type === "ident") {
                switch (token.upper) {
                    case "NULL":
                        this.next();
                        return { type: "literal", value: null };
                    case "TRUE":
                    case "FALSE":
                        this.next();
                        return { type: "literal", value: token.upper === "TRUE" };
                    case "CASE":
                        return this.parseCase();
                    case "EXISTS":
                        return unsupported("EXISTS (subquery)");
                    case "CAST": {
                        if (!this.isPunct("(", 1)) {
                            break;
                        }
                        this.index += 2;
                        const operand = this.parseExpression();
                        this.expectWord("AS");
                        const target = this.parseTypeName();
                        this.expectPunct(")");
                        return { type: "cast", operand, target };
                    }
                    case "CURRENT_DATE":
                    case "CURRENT_TIMESTAMP":
                    case "LOCALTIMESTAMP":
                    case "SYSDATE":
                    case "SYSTIMESTAMP":
                        if (!this.isPunct("(", 1)) {
                            this.next();
                            return { type: "func", name: token.upper, args: [] };
                        }
                        break;
                    default:
                        break;
                }
            }

            if (token.type === "ident" && this.isPunct("(", 1)) {
                return this.parseFunction();
            }

            if (token.type === "ident" || token.type === "qident") {
                const first = this.identifier();
                if (this.acceptPunct(".")) {
                    return { type: "column", table: first, name: this.identifier() };
                }
                return { type: "column", table: null, name: first };
            }

            return this.syntaxError();
        }

        parseFunction() {
            const name = this.next().upper;
            this.expectPunct("(");

            if (AGGREGATES.has(name)) {
                if (name === "COUNT" && this.acceptOp("*")) {
                    this.expectPunct(")");
                    return { type: "aggregate", name, star: true, distinct: false, arg: null };
                }
                const distinct = this.acceptWord("DISTINCT");
                this.acceptWord("ALL");
                const arg = this.parseExpression();
                this.expectPunct(")");
                return { type: "aggregate", name, star: false, distinct, arg };
            }

            const args = [];
            if (!this.acceptPunct(")")) {
                do {
                    args.push(this.parseExpression());
                } while (this.acceptPunct(","));
                this.expectPunct(")");
            }
            if (this.isWord("OVER")) {
                unsupported("Window functions");
            }
            return { type: "func", name, args };
        }

        parseCase() {
            this.expectWord("CASE");
            const subject = this.isWord("WHEN") ? null : this.parseExpression();
            const branches = [];
            while (this.acceptWord("WHEN")) {
                const when = this.parseExpression();
                this.expectWord("THEN");
                branches.push({ when, then: this.parseExpression() });
            }
            const otherwise = this.acceptWord("ELSE") ? this.parseExpression() : null;
            this.expectWord("END");
            return { type: "case", subject, branches, otherwise };
        }
    }

    const defaultLabel = (expr, tokens) => {
        if (expr.type === "column") {
            return expr.name;
        }
        if (expr.type === "aggregate" || expr.type === "func") {
            return expr.name.toLowerCase();
        }
        if (expr.type === "cast") {
            return defaultLabel(expr.operand, tokens);
        }
        return tokens.length === 1 && tokens[0].type === "ident" ? tokens[0].value.toLowerCase() : "?column?";
    };

    /* ------------------------------------------------------------------ values */

    const isNumericString = (value) => typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value));

    const toNumber = (value) => {
        if (value === null || value === undefined) {
            return null;
        }
        if (typeof value === "number") {
            return value;
        }
        if (typeof value === "boolean") {
            return value ? 1 : 0;
        }
        if (isNumericString(value)) {
            return Number(value);
        }
        return fail(`invalid input syntax for type numeric: "${value}"`);
    };

    const compareValues = (a, b) => {
        if (a === null || a === undefined || b === null || b === undefined) {
            return null;
        }
        if (typeof a === "number" || typeof b === "number" || typeof a === "boolean" || typeof b === "boolean") {
            const left = toNumber(a);
            const right = toNumber(b);
            return Math.sign(left - right);
        }
        const left = String(a);
        const right = String(b);
        return left < right ? -1 : (left > right ? 1 : 0);
    };

    const truthy = (value) => value === true || (typeof value === "number" && value !== 0);

    const formatTimestamp = (date) => {
        const pad = (number) => String(number).padStart(2, "0");
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };

    const likeToRegExp = (pattern, caseInsensitive) => {
        const source = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("%", ".*").replaceAll("_", ".");
        return new RegExp(`^${source}$`, caseInsensitive ? "is" : "s");
    };

    const castValue = (value, target) => {
        if (value === null || value === undefined) {
            return null;
        }
        if (/^(INT|INTEGER|SMALLINT|BIGINT|TINYINT|SIGNED|UNSIGNED)$/.test(target)) {
            return Math.trunc(toNumber(value));
        }
        if (/^(NUMBER|NUMERIC|DECIMAL|DEC|FLOAT|REAL|DOUBLE|BINARY_FLOAT|BINARY_DOUBLE)$/.test(target)) {
            return toNumber(value);
        }
        if (/^(BOOLEAN|BOOL)$/.test(target)) {
            return truthy(toNumber(value));
        }
        return String(value);
    };

    const scalarFunctions = {
        UPPER: (s) => (s === null ? null : String(s).toUpperCase()),
        LOWER: (s) => (s === null ? null : String(s).toLowerCase()),
        LENGTH: (s) => (s === null ? null : String(s).length),
        CHAR_LENGTH: (s) => (s === null ? null : String(s).length),
        LEN: (s) => (s === null ? null : String(s).length),
        TRIM: (s) => (s === null ? null : String(s).trim()),
        LTRIM: (s) => (s === null ? null : String(s).trimStart()),
        RTRIM: (s) => (s === null ? null : String(s).trimEnd()),
        COALESCE: (...args) => args.find((arg) => arg !== null && arg !== undefined) ?? null,
        NVL: (...args) => args.find((arg) => arg !== null && arg !== undefined) ?? null,
        IFNULL: (...args) => args.find((arg) => arg !== null && arg !== undefined) ?? null,
        NULLIF: (a, b) => (compareValues(a, b) === 0 ? null : a),
        CONCAT: (...args) => args.filter((arg) => arg !== null && arg !== undefined).join(""),
        REPLACE: (s, from, to) => (s === null ? null : String(s).replaceAll(String(from ?? ""), String(to ?? ""))),
        SUBSTR: (s, start, length) => {
            if (s === null) {
                return null;
            }
            const begin = Math.max(toNumber(start) - 1, 0);
            return length === undefined ? String(s).slice(begin) : String(s).substr(begin, toNumber(length));
        },
        ABS: (n) => (n === null ? null : Math.abs(toNumber(n))),
        FLOOR: (n) => (n === null ? null : Math.floor(toNumber(n))),
        CEIL: (n) => (n === null ? null : Math.ceil(toNumber(n))),
        CEILING: (n) => (n === null ? null : Math.ceil(toNumber(n))),
        ROUND: (n, digits) => {
            if (n === null) {
                return null;
            }
            const factor = 10 ** (digits === undefined ? 0 : toNumber(digits));
            return Math.round(toNumber(n) * factor) / factor;
        },
        MOD: (a, b) => (a === null || b === null ? null : toNumber(a) % toNumber(b)),
        TO_CHAR: (value) => (value === null ? null : String(value)),
        TO_NUMBER: (value) => toNumber(value),
        NOW: () => formatTimestamp(new Date()),
        CURRENT_TIMESTAMP: () => formatTimestamp(new Date()),
        LOCALTIMESTAMP: () => formatTimestamp(new Date()),
        SYSTIMESTAMP: () => formatTimestamp(new Date()),
        SYSDATE: () => formatTimestamp(new Date()),
        CURRENT_DATE: () => formatTimestamp(new Date()).slice(0, 10)
    };
    scalarFunctions.SUBSTRING = scalarFunctions.SUBSTR;

    /* ------------------------------------------------------------------ evaluation */

    const resolveColumn = (node, scope) => {
        const sources = scope.sources;

        if (node.table) {
            const source = sources.find((candidate) => candidate.alias === node.table);
            if (!source) {
                fail(`missing FROM-clause entry for table "${node.table}"`);
            }
            if (!source.columns.includes(node.name)) {
                fail(`column ${node.table}.${node.name} does not exist`);
            }
            return source.row ? source.row[node.name] ?? null : null;
        }

        const matches = sources.filter((source) => source.columns.includes(node.name));
        if (matches.length > 1) {
            fail(`column reference "${node.name}" is ambiguous`);
        }
        if (matches.length === 0) {
            if (scope.outputAliases && node.name in scope.outputAliases) {
                return evaluate(scope.outputAliases[node.name], { ...scope, outputAliases: null });
            }
            fail(`column "${node.name}" does not exist`);
        }
        return matches[0].row ? matches[0].row[node.name] ?? null : null;
    };

    const evaluateAggregate = (node, scope) => {
        if (!scope.groupRows) {
            fail("aggregate functions are not allowed here");
        }

        if (node.star) {
            return scope.groupRows.length;
        }

        let values = scope.groupRows
            .map((rowScope) => evaluate(node.arg, rowScope))
            .filter((value) => value !== null && value !== undefined);

        if (node.distinct) {
            const seen = new Set();
            values = values.filter((value) => {
                const key = JSON.stringify(value);
                return seen.has(key) ? false : (seen.add(key), true);
            });
        }

        switch (node.name) {
            case "COUNT":
                return values.length;
            case "SUM":
                return values.length ? values.reduce((total, value) => total + toNumber(value), 0) : null;
            case "AVG":
                return values.length ? values.reduce((total, value) => total + toNumber(value), 0) / values.length : null;
            case "MIN":
            case "MAX":
                if (!values.length) {
                    return null;
                }
                return values.reduce((best, value) => {
                    const comparison = compareValues(value, best);
                    return (node.name === "MIN" ? comparison < 0 : comparison > 0) ? value : best;
                });
            default:
                return unsupported(node.name);
        }
    };

    const evaluate = (node, scope) => {
        switch (node.type) {
            case "literal":
                return node.value;
            case "param":
                if (!scope.params || !Object.prototype.hasOwnProperty.call(scope.params, node.name)) {
                    fail(`Missing value for parameter :${node.name}`);
                }
                return scope.params[node.name];
            case "column":
                return resolveColumn(node, scope);
            case "negate": {
                const value = evaluate(node.operand, scope);
                return value === null ? null : -toNumber(value);
            }
            case "not": {
                const value = evaluate(node.operand, scope);
                return value === null ? null : !truthy(value);
            }
            case "and": {
                const left = evaluate(node.left, scope);
                if (left !== null && !truthy(left)) {
                    return false;
                }
                const right = evaluate(node.right, scope);
                if (right !== null && !truthy(right)) {
                    return false;
                }
                return left === null || right === null ? null : true;
            }
            case "or": {
                const left = evaluate(node.left, scope);
                if (left !== null && truthy(left)) {
                    return true;
                }
                const right = evaluate(node.right, scope);
                if (right !== null && truthy(right)) {
                    return true;
                }
                return left === null || right === null ? null : false;
            }
            case "compare": {
                const comparison = compareValues(evaluate(node.left, scope), evaluate(node.right, scope));
                if (comparison === null) {
                    return null;
                }
                switch (node.op) {
                    case "=": return comparison === 0;
                    case "<>": return comparison !== 0;
                    case "<": return comparison < 0;
                    case ">": return comparison > 0;
                    case "<=": return comparison <= 0;
                    default: return comparison >= 0;
                }
            }
            case "isNull": {
                const isNull = evaluate(node.operand, scope) === null;
                return node.negated ? !isNull : isNull;
            }
            case "like": {
                const value = evaluate(node.operand, scope);
                const pattern = evaluate(node.pattern, scope);
                if (value === null || pattern === null) {
                    return null;
                }
                const matches = likeToRegExp(pattern, node.caseInsensitive).test(String(value));
                return node.negated ? !matches : matches;
            }
            case "in": {
                const value = evaluate(node.operand, scope);
                if (value === null) {
                    return null;
                }
                let sawNull = false;
                for (const candidate of node.values) {
                    const comparison = compareValues(value, evaluate(candidate, scope));
                    if (comparison === 0) {
                        return !node.negated;
                    }
                    if (comparison === null) {
                        sawNull = true;
                    }
                }
                return sawNull ? null : node.negated;
            }
            case "between": {
                const value = evaluate(node.operand, scope);
                const low = compareValues(value, evaluate(node.low, scope));
                const high = compareValues(value, evaluate(node.high, scope));
                if (low === null || high === null) {
                    return null;
                }
                const inside = low >= 0 && high <= 0;
                return node.negated ? !inside : inside;
            }
            case "binary": {
                const left = evaluate(node.left, scope);
                const right = evaluate(node.right, scope);
                if (node.op === "||") {
                    return [left, right].filter((value) => value !== null && value !== undefined).join("");
                }
                if (left === null || right === null) {
                    return null;
                }
                const a = toNumber(left);
                const b = toNumber(right);
                switch (node.op) {
                    case "+": return a + b;
                    case "-": return a - b;
                    case "*": return a * b;
                    case "%":
                        if (b === 0) {
                            fail("division by zero");
                        }
                        return a % b;
                    default:
                        if (b === 0) {
                            fail("division by zero");
                        }
                        return Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b;
                }
            }
            case "cast":
                return castValue(evaluate(node.operand, scope), node.target);
            case "case": {
                const subject = node.subject ? evaluate(node.subject, scope) : null;
                for (const branch of node.branches) {
                    const matched = node.subject
                        ? compareValues(subject, evaluate(branch.when, scope)) === 0
                        : truthy(evaluate(branch.when, scope));
                    if (matched) {
                        return evaluate(branch.then, scope);
                    }
                }
                return node.otherwise ? evaluate(node.otherwise, scope) : null;
            }
            case "func": {
                const fn = scalarFunctions[node.name];
                if (!fn) {
                    fail(`function ${node.name.toLowerCase()}() does not exist`);
                }
                return fn(...node.args.map((arg) => {
                    const value = evaluate(arg, scope);
                    return value === undefined ? null : value;
                }));
            }
            case "aggregate":
                return evaluateAggregate(node, scope);
            default:
                return fail("unsupported expression");
        }
    };

    const containsAggregate = (node) => {
        if (!node || typeof node !== "object") {
            return false;
        }
        if (node.type === "aggregate") {
            return true;
        }
        return Object.values(node).some((value) => (Array.isArray(value)
            ? value.some(containsAggregate)
            : (value && typeof value === "object" ? containsAggregate(value) : false)));
    };

    /* ------------------------------------------------------------------ execution */

    const getTable = (tables, name) => {
        if (!Object.prototype.hasOwnProperty.call(tables, name)) {
            fail(`relation "${name}" does not exist`);
        }
        return tables[name];
    };

    const columnNames = (table) => table.columns.map((col) => col.name);

    const coerceForColumn = (value, column) => {
        if (value === null || value === undefined) {
            return null;
        }
        if (column.type === "number") {
            if (typeof value === "number") {
                return value;
            }
            if (isNumericString(value)) {
                return Number(value);
            }
            if (typeof value === "boolean") {
                return value ? 1 : 0;
            }
            return fail(`invalid input syntax for type numeric: "${value}"`);
        }
        return String(value);
    };

    const buildSourceScopes = (core, tables, params) => {
        if (!core.from) {
            return [{ sources: [], params }];
        }

        const toSource = (ref) => {
            if (ref.name === "dual") {
                return { alias: ref.alias, columns: ["dummy"], rows: [{ dummy: "X" }] };
            }
            const table = getTable(tables, ref.name);
            return { alias: ref.alias, columns: columnNames(table), rows: table.rows };
        };

        const base = toSource(core.from);
        let scopes = base.rows.map((row) => ({ sources: [{ alias: base.alias, columns: base.columns, row }], params }));

        core.joins.forEach((join) => {
            const right = toSource(join.table);
            if (scopes.some((scope) => scope.sources.some((source) => source.alias === right.alias))) {
                fail(`table name "${right.alias}" specified more than once`);
            }
            const joined = [];
            scopes.forEach((scope) => {
                let matched = false;
                right.rows.forEach((row) => {
                    const candidate = { sources: [...scope.sources, { alias: right.alias, columns: right.columns, row }], params };
                    if (join.kind === "CROSS" || truthy(evaluate(join.on, candidate))) {
                        joined.push(candidate);
                        matched = true;
                    }
                });
                if (!matched && join.kind === "LEFT") {
                    joined.push({ sources: [...scope.sources, { alias: right.alias, columns: right.columns, row: null }], params });
                }
            });
            scopes = joined;
        });

        return scopes;
    };

    const emptySourcesFor = (core, tables) => {
        if (!core.from) {
            return [];
        }
        return [core.from, ...core.joins.map((join) => join.table)].map((ref) => ({
            alias: ref.alias,
            columns: ref.name === "dual" ? ["dummy"] : columnNames(getTable(tables, ref.name)),
            row: null
        }));
    };

    const runSelectCore = (core, tables, params) => {
        let scopes = buildSourceScopes(core, tables, params);

        if (core.where) {
            if (containsAggregate(core.where)) {
                fail("aggregate functions are not allowed in WHERE");
            }
            scopes = scopes.filter((scope) => truthy(evaluate(core.where, scope)));
        }

        const outputAliases = {};
        core.items.forEach((item) => {
            if (!item.star && item.alias) {
                outputAliases[item.alias] = item.expr;
            }
        });

        const grouped = core.groupBy.length > 0 || core.having !== null
            || core.items.some((item) => !item.star && containsAggregate(item.expr));

        if (grouped) {
            const groups = new Map();
            scopes.forEach((scope) => {
                const keyScope = { ...scope, outputAliases };
                const key = JSON.stringify(core.groupBy.map((expr) => evaluate(expr, keyScope)));
                if (!groups.has(key)) {
                    groups.set(key, []);
                }
                groups.get(key).push(scope);
            });

            if (groups.size === 0 && core.groupBy.length === 0) {
                groups.set("[]", []);
            }

            scopes = Array.from(groups.values()).map((members) => ({
                sources: members[0]?.sources ?? emptySourcesFor(core, tables),
                params,
                groupRows: members
            }));

            if (core.having) {
                scopes = scopes.filter((scope) => truthy(evaluate(core.having, { ...scope, outputAliases })));
            }
        }

        const labels = [];
        core.items.forEach((item) => {
            if (!item.star) {
                labels.push(item.label);
                return;
            }
            const sources = scopes[0]?.sources ?? emptySourcesFor(core, tables);
            if (!core.from) {
                fail("SELECT * with no tables specified is not valid");
            }
            const matching = item.table ? sources.filter((source) => source.alias === item.table) : sources;
            if (item.table && matching.length === 0) {
                fail(`missing FROM-clause entry for table "${item.table}"`);
            }
            matching.forEach((source) => labels.push(...source.columns));
        });

        let rows = scopes.map((scope) => {
            const values = [];
            core.items.forEach((item) => {
                if (!item.star) {
                    values.push(evaluate(item.expr, scope));
                    return;
                }
                scope.sources
                    .filter((source) => !item.table || source.alias === item.table)
                    .forEach((source) => source.columns.forEach((name) => values.push(source.row ? source.row[name] ?? null : null)));
            });
            return { values, scope: { ...scope, outputAliases } };
        });

        if (core.distinct) {
            rows = dedupe(rows);
        }

        return { labels, rows };
    };

    const dedupe = (rows) => {
        const seen = new Set();
        return rows.filter((row) => {
            const key = JSON.stringify(row.values);
            return seen.has(key) ? false : (seen.add(key), true);
        });
    };

    const runQuery = (query, tables, params) => {
        const results = query.cores.map((core) => runSelectCore(core, tables, params));
        const labels = results[0].labels;
        let rows = results[0].rows;

        query.unions.forEach((kind, index) => {
            const next = results[index + 1];
            if (next.labels.length !== labels.length) {
                fail("each UNION query must have the same number of columns");
            }
            rows = rows.concat(next.rows.map((row) => ({ values: row.values, scope: null })));
            if (kind === "DISTINCT") {
                rows = dedupe(rows);
            }
        });

        if (query.unions.length) {
            rows = rows.map((row) => ({ values: row.values, scope: null }));
        }

        if (query.orderBy.length) {
            const sortValue = (row, expr) => {
                if (expr.type === "literal" && Number.isInteger(expr.value)) {
                    if (expr.value < 1 || expr.value > labels.length) {
                        fail(`ORDER BY position ${expr.value} is not in select list`);
                    }
                    return row.values[expr.value - 1];
                }
                if (expr.type === "column" && !expr.table && labels.includes(expr.name)) {
                    return row.values[labels.indexOf(expr.name)];
                }
                if (!row.scope) {
                    fail("ORDER BY on a UNION result must use output column names or positions");
                }
                return evaluate(expr, row.scope);
            };

            const keyed = rows.map((row) => ({ row, keys: query.orderBy.map((item) => sortValue(row, item.expr)) }));
            keyed.sort((a, b) => {
                for (let i = 0; i < query.orderBy.length; i++) {
                    const { descending, nullsFirst } = query.orderBy[i];
                    const left = a.keys[i];
                    const right = b.keys[i];
                    if (left === null && right === null) {
                        continue;
                    }
                    if (left === null || right === null) {
                        return (left === null) === nullsFirst ? -1 : 1;
                    }
                    const comparison = compareValues(left, right);
                    if (comparison !== 0) {
                        return descending ? -comparison : comparison;
                    }
                }
                return 0;
            });
            rows = keyed.map((entry) => entry.row);
        }

        const emptyScope = { sources: [], params };
        const offset = query.offset ? toNumber(evaluate(query.offset, emptyScope)) : 0;
        const limit = query.limit ? toNumber(evaluate(query.limit, emptyScope)) : null;
        rows = rows.slice(offset, limit === null ? undefined : offset + limit);

        return { columns: labels, rows: rows.map((row) => row.values) };
    };

    const nextAutoIncrementValue = (table) => table.rows.reduce((max, row) => {
        const value = row[table.autoIncrement];
        return typeof value === "number" && value > max ? value : max;
    }, 0) + 1;

    const runInsert = (statement, tables, params) => {
        const table = getTable(tables, statement.table);
        const names = columnNames(table);
        const targetColumns = statement.columns ?? names;

        targetColumns.forEach((name) => {
            if (!names.includes(name)) {
                fail(`column "${name}" of relation "${statement.table}" does not exist`);
            }
        });

        const valueRows = statement.query
            ? runQuery(statement.query, tables, params).rows
            : statement.rows.map((exprs) => exprs.map((expr) => evaluate(expr, { sources: [], params })));

        const newRows = valueRows.map((values) => {
            if (values.length !== targetColumns.length) {
                fail(values.length > targetColumns.length
                    ? "INSERT has more expressions than target columns"
                    : "INSERT has more target columns than expressions");
            }
            const row = Object.fromEntries(names.map((name) => [name, null]));
            targetColumns.forEach((name, index) => {
                row[name] = coerceForColumn(values[index], table.columns.find((col) => col.name === name));
            });
            return row;
        });

        newRows.forEach((row) => {
            if (table.autoIncrement && row[table.autoIncrement] === null) {
                row[table.autoIncrement] = nextAutoIncrementValue(table);
            }
            table.rows.push(row);
        });

        return newRows.length;
    };

    const matchingRows = (table, alias, where, params) => {
        const columns = columnNames(table);
        return table.rows.filter((row) => !where || truthy(evaluate(where, { sources: [{ alias, columns, row }], params })));
    };

    const runUpdate = (statement, tables, params) => {
        const table = getTable(tables, statement.table);
        const columns = columnNames(table);

        statement.assignments.forEach(({ column }) => {
            if (!columns.includes(column)) {
                fail(`column "${column}" of relation "${statement.table}" does not exist`);
            }
        });

        const targets = matchingRows(table, statement.alias, statement.where, params);
        const changes = targets.map((row) => {
            const scope = { sources: [{ alias: statement.alias, columns, row }], params };
            return statement.assignments.map(({ column, expr }) => [
                column,
                coerceForColumn(evaluate(expr, scope), table.columns.find((col) => col.name === column))
            ]);
        });

        targets.forEach((row, index) => {
            changes[index].forEach(([column, value]) => {
                row[column] = value;
            });
        });

        return targets.length;
    };

    const runDelete = (statement, tables, params) => {
        const table = getTable(tables, statement.table);
        const targets = new Set(matchingRows(table, statement.alias, statement.where, params));
        table.rows = table.rows.filter((row) => !targets.has(row));
        return targets.size;
    };

    const runStatement = (statement, tables, params) => {
        switch (statement.type) {
            case "select":
                return { query: runQuery(statement, tables, params) };
            case "insert":
                return { updateCount: runInsert(statement, tables, params) };
            case "update":
                return { updateCount: runUpdate(statement, tables, params) };
            case "delete":
                return { updateCount: runDelete(statement, tables, params) };
            case "create":
            case "createAs": {
                if (Object.prototype.hasOwnProperty.call(tables, statement.table)) {
                    if (statement.ifNotExists) {
                        return { updateCount: 0 };
                    }
                    fail(`relation "${statement.table}" already exists`);
                }
                if (statement.type === "create") {
                    tables[statement.table] = { columns: statement.columns, autoIncrement: statement.autoIncrement, rows: [] };
                    return { updateCount: 0 };
                }
                const result = runQuery(statement.query, tables, params);
                const columns = result.columns.map((name, index) => ({
                    name,
                    type: result.rows.length && typeof result.rows[0][index] === "number" ? "number" : "text"
                }));
                tables[statement.table] = {
                    columns,
                    autoIncrement: null,
                    rows: result.rows.map((values) => Object.fromEntries(columns.map((col, index) => [col.name, values[index]])))
                };
                return { updateCount: result.rows.length };
            }
            case "drop":
                if (!Object.prototype.hasOwnProperty.call(tables, statement.table)) {
                    if (statement.ifExists) {
                        return { updateCount: 0 };
                    }
                    fail(`table "${statement.table}" does not exist`);
                }
                delete tables[statement.table];
                return { updateCount: 0 };
            case "truncate":
                getTable(tables, statement.table).rows = [];
                return { updateCount: 0 };
            default:
                return { updateCount: 0 };
        }
    };

    const stringify = (value) => {
        if (value === null || value === undefined) {
            return null;
        }
        if (typeof value === "number") {
            return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(10)));
        }
        return String(value);
    };

    /**
     * Runs a (possibly multi-statement) script, statement by statement like the original
     * ExecutionService: the result is the last statement's rows if it was a query, otherwise
     * the total rows affected. Mutates `tables` in place (each statement "auto-commits").
     */
    const execute = (sqlText, parameters, tables) => {
        const params = parameters ?? {};
        const statements = splitStatements(tokenize(String(sqlText ?? "")));

        let columns = [];
        let rows = [];
        let rowsAffected = 0;
        let lastWasQuery = false;

        statements.forEach((tokens) => {
            tokens.filter((token) => token.type === "param").forEach((token) => {
                if (!Object.prototype.hasOwnProperty.call(params, token.value)) {
                    fail(`Missing value for parameter :${token.value}`);
                }
            });

            const outcome = runStatement(new Parser(tokens).parseStatement(), tables, params);
            if (outcome.query) {
                columns = outcome.query.columns;
                rows = outcome.query.rows.slice(0, MAX_ROWS).map((row) => row.map(stringify));
                lastWasQuery = true;
            } else {
                rowsAffected += Math.max(outcome.updateCount, 0);
                lastWasQuery = false;
            }
        });

        return lastWasQuery
            ? { columns, rows, recordsReturned: rows.length, rowsAffected: null }
            : { columns: [], rows: [], recordsReturned: null, rowsAffected };
    };

    global.QaLiteSqlEngine = {
        MockSqlError,
        execute,
        extractParameterNames
    };
})(window);
