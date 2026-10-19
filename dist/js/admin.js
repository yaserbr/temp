const userSearchInput = document.querySelector("#user-search");
const accessList = document.querySelector("#access-list");
const accessSearchEmpty = document.querySelector("#access-search-empty");

if (userSearchInput && accessList) {
    const userRows = Array.from(accessList.querySelectorAll(".access-user"));

    userSearchInput.addEventListener("input", () => {
        const query = userSearchInput.value.trim().toLowerCase();
        let visibleCount = 0;

        userRows.forEach((row) => {
            const isMatch = row.dataset.username.includes(query);
            row.hidden = !isMatch;
            if (isMatch) {
                visibleCount += 1;
            }
        });

        if (accessSearchEmpty) {
            accessSearchEmpty.hidden = userRows.length === 0 || visibleCount !== 0;
        }
    });
}

document.querySelectorAll(".access-user-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
        const row = toggle.closest(".access-user");
        const expanded = row?.classList.toggle("is-expanded") ?? false;
        toggle.setAttribute("aria-expanded", String(expanded));
    });
});

document.querySelectorAll(".js-confirm-delete").forEach((form) => {
    form.addEventListener("submit", (event) => {
        const message = form.dataset.confirmMessage || "Delete this record? This cannot be undone.";
        if (!window.confirm(message)) {
            event.preventDefault();
        }
    });
});
