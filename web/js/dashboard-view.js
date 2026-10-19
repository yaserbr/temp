// Renders the dashboard markup that dashboard.html used to get from Thymeleaf, using the local
// mock data. Runs before page-transition.js (deferred), which then wires up the builder as before.
(() => {
    const view = window.QaLite.dashboard.getView();

    const escapeHtml = (value) => String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");

    if (view.isAdmin) {
        document.querySelector("#dashboard-actions").insertAdjacentHTML("afterbegin",
            '<a class="topbar-link" href="admin.html">Admin</a>');
    }

    document.querySelector("#env-rail").insertAdjacentHTML("beforeend", view.environments.length === 0
        ? '<p class="rail-empty">No environments allowed.</p>'
        : view.environments.map((environment, index) => `
            <button type="button" class="env-container${index === 0 ? " is-active" : ""}"
                data-env="${escapeHtml(environment.name)}" data-env-id="${environment.envId}"
                data-env-note="${escapeHtml(environment.note)}">
                <span class="env-label">${escapeHtml(environment.name)}</span>
                <span class="env-note">${escapeHtml(environment.note)}</span>
            </button>`).join(""));

    document.querySelector("#command-shelf").insertAdjacentHTML("beforeend", view.sqlCommands.length === 0
        ? '<p class="rail-empty">No SQL commands allowed.</p>'
        : view.sqlCommands.map((command) => `
            <button type="button" class="command-block ${command.tone}" draggable="true"
                data-command="${command.commandId}" data-sql-id="${command.sqlId}"
                data-title="${escapeHtml(command.sqlName)}"
                data-params="${escapeHtml(JSON.stringify(command.parameterNames))}">
                <span class="block-title">${escapeHtml(command.sqlName)}</span>
            </button>`).join(""));

    const { activeEnvironment, activeCommand } = view;
    let canvas = "";

    if (!activeEnvironment || !activeCommand) {
        canvas += '<div class="workflow-empty">Add access from Admin to start.</div>';
    }

    if (activeEnvironment) {
        canvas += `
            <div class="workflow-env-block" id="workflow-env-block" data-env="${escapeHtml(activeEnvironment.name)}">
                <span class="workflow-env-name" id="workflow-env-name">${escapeHtml(activeEnvironment.name)}</span>
                <span class="workflow-env-note" id="workflow-env-note">${escapeHtml(activeEnvironment.note)}</span>
            </div>`;
    }

    if (activeCommand) {
        canvas += `
            <div id="workflow-command-block" class="workflow-command-block ${activeCommand.tone} is-disconnected"
                data-command="${activeCommand.commandId}">
                <span class="workflow-command-title" id="workflow-command-title">${escapeHtml(activeCommand.sqlName)}</span>
                <div id="workflow-command-params" class="workflow-command-params">
                    ${activeCommand.parameterNames.map((paramName) => `
                    <label class="workflow-command-input-label">
                        <span>${escapeHtml(paramName)}</span>
                        <input type="text" data-param-name="${escapeHtml(paramName)}" aria-label="${escapeHtml(paramName)}">
                    </label>`).join("")}
                </div>
            </div>`;
    }

    document.querySelector("#workflow-canvas").innerHTML = canvas;
})();
