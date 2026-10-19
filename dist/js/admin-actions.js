// Handles the admin forms locally (they used to POST to /admin/... and redirect back with a flash
// message). Loaded after admin.js, so a cancelled delete confirmation is already defaultPrevented.
(() => {
    const { admin, auth, flash } = window.QaLite;

    const reloadWithFlash = (type, message) => {
        flash.set("admin", type, message);
        window.location.assign("admin.html");
    };

    const submitButtonsOf = (form) => Array.from(form.elements).filter((element) => element.type === "submit");

    const runAction = async (form, action, successMessage) => {
        submitButtonsOf(form).forEach((button) => {
            button.disabled = true;
        });

        try {
            await action();
            reloadWithFlash("success", successMessage);
        } catch (error) {
            reloadWithFlash("error", error.message || "Database operation failed.");
        }
    };

    const actions = {
        "create-environment": (data) => [
            () => admin.createEnvironment(Object.fromEntries(data)),
            "Environment added."
        ],
        "create-sql": (data) => [
            () => admin.createSqlDefinition(Object.fromEntries(data)),
            "SQL command added."
        ],
        "update-permissions": (data, id) => [
            () => admin.updateUserPermissions(id, data.getAll("environmentIds").map(Number), data.getAll("sqlIds").map(Number)),
            "User access updated."
        ],
        "delete-user": (data, id) => [() => admin.deleteUser(id), "User deleted."],
        "delete-environment": (data, id) => [() => admin.deleteEnvironment(id), "Environment deleted."],
        "delete-sql": (data, id) => [() => admin.deleteSqlDefinition(id), "SQL command deleted."],
        "test-environment": (data, id) => [
            () => admin.testConnection(id),
            "Connection succeeded. (Demo mode: simulated - no real database was contacted.)"
        ]
    };

    document.querySelectorAll("form[data-admin-action]").forEach((form) => {
        form.addEventListener("submit", (event) => {
            if (event.defaultPrevented) {
                return;
            }
            event.preventDefault();

            const [action, successMessage] = actions[form.dataset.adminAction](
                new FormData(form),
                Number(form.dataset.recordId)
            );
            runAction(form, action, successMessage);
        });
    });

    document.querySelector("#admin-logout-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        await auth.logout();
        window.location.assign("login.html?logout");
    });
})();
