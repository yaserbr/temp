// Renders the admin markup that admin.html used to get from Thymeleaf, using the local mock data.
// Runs before admin.js (search / expand / delete confirmation) and admin-actions.js (form handling).
(() => {
    const view = window.QaLite.admin.getView();
    const flash = window.QaLite.flash.take("admin");

    const escapeHtml = (value) => String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");

    const isEmpty = (value) => value === null || value === undefined || String(value) === "";

    if (flash) {
        document.querySelector("#admin-layout").insertAdjacentHTML("afterbegin",
            `<div class="admin-flash ${flash.type === "success" ? "is-success" : "is-error"}">${escapeHtml(flash.message)}</div>`);
    }

    document.querySelector("#env-db-type").innerHTML = view.databaseTypes
        .map((type) => `<option value="${escapeHtml(type.value)}">${escapeHtml(type.label)}</option>`)
        .join("");

    if (view.users.length > 0) {
        document.querySelector("#access-list").insertAdjacentHTML("beforebegin", `
            <div class="access-search">
                <svg class="access-search-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="11" cy="11" r="7"></circle>
                    <path d="M21 21l-4.3-4.3"></path>
                </svg>
                <input type="search" id="user-search" placeholder="Search username" autocomplete="off"
                    aria-label="Search users by username">
            </div>`);
    }

    const environmentChecks = (user) => (view.environments.length === 0
        ? '<p class="admin-empty">No environments yet.</p>'
        : view.environments.map((environment) => `
            <label class="check-row">
                <input type="checkbox" name="environmentIds" value="${environment.envId}"
                    form="access-form-${user.userId}"${user.environmentIds.has(environment.envId) ? " checked" : ""}>
                <span>
                    <strong>${escapeHtml(environment.name)}</strong>
                    <small>${escapeHtml(isEmpty(environment.description) ? environment.dbType : environment.description)}</small>
                </span>
            </label>`).join(""));

    const sqlChecks = (user) => (view.sqlDefinitions.length === 0
        ? '<p class="admin-empty">No SQL commands yet.</p>'
        : view.sqlDefinitions.map((sql) => `
            <label class="check-row">
                <input type="checkbox" name="sqlIds" value="${sql.sqlId}"
                    form="access-form-${user.userId}"${user.sqlIds.has(sql.sqlId) ? " checked" : ""}>
                <span>
                    <strong>${escapeHtml(sql.sqlName)}</strong>
                    <small>${escapeHtml(isEmpty(sql.sqlDescription) ? "SQL command" : sql.sqlDescription)}</small>
                </span>
            </label>`).join(""));

    document.querySelector("#access-list").innerHTML = `
        ${view.users.length === 0 ? '<p class="admin-empty">No standard users yet.</p>' : ""}
        <p class="admin-empty" id="access-search-empty" hidden>No users match your search.</p>
        ${view.users.map((user) => `
        <div class="access-user" data-username="${escapeHtml(user.username.toLowerCase())}">

            <form id="access-form-${user.userId}" action="#" method="post"
                data-admin-action="update-permissions" data-record-id="${user.userId}"></form>

            <div class="access-user-header">
                <button type="button" class="access-user-toggle" aria-expanded="false">
                    <svg class="access-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M9 6l6 6-6 6"></path>
                    </svg>
                    <span class="access-user-identity">
                        <strong>${escapeHtml(user.username)}</strong>
                        <span>${escapeHtml(user.role)}</span>
                    </span>
                </button>
                <div class="access-user-actions">
                    <button type="submit" form="access-form-${user.userId}"
                        class="admin-submit compact">Save Access</button>
                    <form class="admin-inline-form js-confirm-delete" action="#" method="post"
                        data-admin-action="delete-user" data-record-id="${user.userId}"
                        data-confirm-message="Delete this user? Their access and execution history will be deleted too. This cannot be undone.">
                        <button type="submit" class="admin-delete-button">Delete</button>
                    </form>
                </div>
            </div>

            <div class="permission-grid">
                <fieldset class="permission-set">
                    <legend>Environments</legend>
                    ${environmentChecks(user)}
                </fieldset>

                <fieldset class="permission-set">
                    <legend>SQL Commands</legend>
                    ${sqlChecks(user)}
                </fieldset>
            </div>
        </div>`).join("")}`;

    document.querySelector("#environment-rows").innerHTML = view.environments.length === 0
        ? '<tr><td colspan="4">No environments yet.</td></tr>'
        : view.environments.map((environment) => `
            <tr>
                <td>
                    <strong>${escapeHtml(environment.name)}</strong>
                    <span>${escapeHtml(isEmpty(environment.description) ? "No description" : environment.description)}</span>
                </td>
                <td>${escapeHtml(environment.dbType)}</td>
                <td>${escapeHtml(environment.dbUsername)}</td>
                <td>
                    <div class="admin-row-actions">
                        <form class="admin-inline-form" action="#" method="post"
                            data-admin-action="test-environment" data-record-id="${environment.envId}">
                            <button type="submit" class="admin-test-button">Test</button>
                        </form>
                        <form class="admin-inline-form js-confirm-delete" action="#" method="post"
                            data-admin-action="delete-environment" data-record-id="${environment.envId}"
                            data-confirm-message="Delete this environment? Its execution history will be deleted too. This cannot be undone.">
                            <button type="submit" class="admin-delete-button">Delete</button>
                        </form>
                    </div>
                </td>
            </tr>`).join("");

    document.querySelector("#sql-rows").innerHTML = view.sqlDefinitions.length === 0
        ? '<tr><td colspan="3">No SQL commands yet.</td></tr>'
        : view.sqlDefinitions.map((sql) => `
            <tr>
                <td>
                    <strong>${escapeHtml(sql.sqlName)}</strong>
                    <span>${escapeHtml(isEmpty(sql.sqlDescription) ? "No description" : sql.sqlDescription)}</span>
                </td>
                <td><code>${escapeHtml(sql.sqlText)}</code></td>
                <td>
                    <form class="admin-inline-form js-confirm-delete" action="#" method="post"
                        data-admin-action="delete-sql" data-record-id="${sql.sqlId}"
                        data-confirm-message="Delete this SQL command? Its execution history will be deleted too. This cannot be undone.">
                        <button type="submit" class="admin-delete-button">Delete</button>
                    </form>
                </td>
            </tr>`).join("");
})();
