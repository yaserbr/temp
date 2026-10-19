const loginPage = document.querySelector(".login-page");
const loginForm = document.querySelector(".login-form");
const loginError = document.querySelector("#login-error");
const dashboardPage = document.querySelector(".dashboard-page");
const logoutForm = document.querySelector(".logout-form");
const LOGIN_RETURN_DURATION = 980;
const DASHBOARD_EXIT_DURATION = 760;
const mockApi = window.QaLite;

const forceReflow = (element) => {
    element.getBoundingClientRect();
};

const startPageExit = (page) => {
    forceReflow(page);
    window.requestAnimationFrame(() => page.classList.add("is-leaving"));
};

const setButtonState = (button, text, disabled) => {
    button.disabled = disabled;
    button.textContent = text;
};

const setIconButtonState = (button, label, disabled) => {
    button.disabled = disabled;
    button.title = label;
    button.setAttribute("aria-label", label);
};

const waitForLoginVisual = async () => {
    const visualImage = loginPage?.querySelector(".login-visual-layer img");

    if (!visualImage || typeof visualImage.decode !== "function") {
        return;
    }

    try {
        await visualImage.decode();
    } catch (error) {
        // The transition can still run if decoding is unsupported or interrupted.
    }
};

if (loginPage?.classList.contains("is-returning")) {
    const clearReturnState = () => {
        loginPage.classList.remove("is-returning", "is-entered");
        if (window.location.search.includes("returning")) {
            window.history.replaceState({}, "", window.location.pathname);
        }
    };

    const startReturnAnimation = async () => {
        await waitForLoginVisual();
        window.requestAnimationFrame(() => {
            forceReflow(loginPage);
            window.requestAnimationFrame(() => {
                loginPage.classList.add("is-entered");
                window.setTimeout(clearReturnState, LOGIN_RETURN_DURATION);
            });
        });
    };

    if (document.readyState === "complete") {
        window.setTimeout(startReturnAnimation, 80);
    } else {
        window.addEventListener("load", () => {
            window.setTimeout(startReturnAnimation, 80);
        }, { once: true });
    }
}

if (loginPage && loginForm) {
    const registerError = document.querySelector("#register-error");
    const authAlerts = Array.from(loginPage.querySelectorAll(".form-panel .alert"));

    const register = async (submitButton) => {
        authAlerts.forEach((alert) => alert.classList.add("is-hidden"));
        setButtonState(submitButton, "Register", true);

        try {
            await mockApi.auth.register(loginForm.elements.username.value, loginForm.elements.password.value);
            loginForm.elements.password.value = "";
            document.querySelector("#register-success")?.classList.remove("is-hidden");
        } catch (error) {
            registerError.textContent = error.message || "Registration failed. Please try again.";
            registerError.classList.remove("is-hidden");
        } finally {
            setButtonState(submitButton, "Register", false);
        }
    };

    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (event.submitter?.dataset.authAction === "register") {
            await register(event.submitter);
            return;
        }

        const submitButton = event.submitter || loginForm.querySelector("button[type='submit']");
        const successUrl = loginForm.dataset.successUrl || "index.html";

        authAlerts.forEach((alert) => alert.classList.add("is-hidden"));
        setButtonState(submitButton, "Signing in...", true);

        try {
            const signedIn = await mockApi.auth.login(loginForm.elements.username.value, loginForm.elements.password.value);

            if (!signedIn) {
                throw new Error("Login failed");
            }

            loginPage.classList.remove("is-returning", "is-entered");
            startPageExit(loginPage);
            window.setTimeout(() => {
                window.location.assign(successUrl);
            }, 760);
        } catch (error) {
            loginError?.classList.remove("is-hidden");
            setButtonState(submitButton, "Login", false);
        }
    });
}

if (dashboardPage && logoutForm) {
    logoutForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        const submitButton = logoutForm.querySelector("button[type='submit']");
        const loginUrl = logoutForm.dataset.loginUrl || "login.html?returning=true";

        setIconButtonState(submitButton, "Signing out...", true);
        startPageExit(dashboardPage);

        window.setTimeout(async () => {
            try {
                await mockApi.auth.logout();

                window.location.assign(loginUrl);
            } catch (error) {
                dashboardPage.classList.remove("is-leaving");
                setIconButtonState(submitButton, "Logout", false);
            }
        }, DASHBOARD_EXIT_DURATION);
    });
}

const builderLayout = document.querySelector(".builder-layout");

if (builderLayout) {
    const envButtons = Array.from(document.querySelectorAll(".env-container"));
    const commandBlocks = Array.from(document.querySelectorAll(".command-block"));
    const workflowCanvas = document.querySelector("#workflow-canvas");
    const workflowEnvBlock = document.querySelector("#workflow-env-block");
    const workflowEnvName = document.querySelector("#workflow-env-name");
    const workflowEnvNote = document.querySelector("#workflow-env-note");
    const workflowCommandBlock = document.querySelector("#workflow-command-block");
    const workflowCommandTitle = document.querySelector("#workflow-command-title");
    const workflowCommandParams = document.querySelector("#workflow-command-params");
    const runButton = document.querySelector("#run-command");
    const resultOutput = document.querySelector("#result-output");

    const CONNECT_DISTANCE = 54;
    const DISCONNECT_DISTANCE = 92;
    const activeEnvironmentButton = envButtons.find((button) => button.classList.contains("is-active")) || envButtons[0];

    const getEnvironmentFromButton = (button) => ({
        id: button?.dataset.env || "",
        envId: button?.dataset.envId || "",
        note: button?.dataset.envNote || ""
    });

    let activeEnvironment = getEnvironmentFromButton(activeEnvironmentButton);
    let activeCommand = null;
    let commandPosition = { x: 0, y: 0 };
    let dragState = null;

    const connectionState = {
        environmentId: null,
        commandId: null,
        connectionStatus: "disconnected"
    };

    const escapeHtml = (value) => String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");

    const getCommandTone = (commandBlock) => Array.from(commandBlock.classList)
            .find((className) => className.startsWith("is-")) || "is-blue";

    const parseParamNames = (raw) => {
        try {
            const parsed = JSON.parse(raw || "[]");
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    };

    const getCommandFromBlock = (commandBlock) => ({
        id: commandBlock.dataset.command,
        sqlId: commandBlock.dataset.sqlId,
        title: commandBlock.dataset.title,
        parameterNames: parseParamNames(commandBlock.dataset.params),
        tone: getCommandTone(commandBlock)
    });

    const commandsById = new Map(commandBlocks.map((commandBlock) => [
        commandBlock.dataset.command,
        getCommandFromBlock(commandBlock)
    ]));

    const getConnectorSize = () => {
        const styles = window.getComputedStyle(workflowCanvas);
        return {
            width: parseFloat(styles.getPropertyValue("--connector-width")) || 38,
            height: parseFloat(styles.getPropertyValue("--connector-height")) || 58
        };
    };

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

    const setConnectionState = (environmentId, commandId, status) => {
        connectionState.environmentId = environmentId;
        connectionState.commandId = commandId;
        connectionState.connectionStatus = status;
    };

    const setConnectionClasses = (connected) => {
        workflowCanvas?.classList.toggle("is-connected", connected);
        workflowCanvas?.classList.remove("is-connection-available");
        workflowCommandBlock?.classList.toggle("is-connected", connected);
        workflowCommandBlock?.classList.toggle("is-disconnected", !connected);
        workflowCommandBlock?.classList.remove("is-connection-available");
    };

    const markDisconnected = () => {
        setConnectionState(null, activeCommand?.id || null, "disconnected");
        setConnectionClasses(false);
    };

    const clearResult = () => {
        if (!resultOutput) {
            return;
        }

        resultOutput.classList.add("is-empty");
        resultOutput.textContent = "No execution yet.";
    };

    const updateRunButton = () => {
        if (runButton) {
            runButton.disabled = connectionState.connectionStatus !== "connected";
        }
    };

    const setCommandPosition = (x, y) => {
        if (!workflowCanvas || !workflowCommandBlock) {
            return;
        }

        const connector = getConnectorSize();
        const maxX = Math.max(connector.width + 8, workflowCanvas.clientWidth - workflowCommandBlock.offsetWidth - 10);
        const maxY = Math.max(8, workflowCanvas.clientHeight - workflowCommandBlock.offsetHeight - 8);

        commandPosition = {
            x: clamp(x, connector.width + 8, maxX),
            y: clamp(y, 8, maxY)
        };

        workflowCommandBlock.style.left = `${commandPosition.x}px`;
        workflowCommandBlock.style.top = `${commandPosition.y}px`;
    };

    const getDefaultCommandPosition = () => {
        if (!workflowCanvas || !workflowCommandBlock) {
            return { x: 430, y: 35 };
        }

        if (workflowCanvas.clientWidth < 620) {
            return {
                x: 92,
                y: 210
            };
        }

        return {
            x: Math.max(280, workflowCanvas.clientWidth - workflowCommandBlock.offsetWidth - 54),
            y: 35
        };
    };

    const getConnectionDelta = () => {
        const commandCenterY = commandPosition.y + (workflowCommandBlock.offsetHeight / 2);
        const envCenterY = workflowEnvBlock.offsetTop + (workflowEnvBlock.offsetHeight / 2);
        const envRight = workflowEnvBlock.offsetLeft + workflowEnvBlock.offsetWidth;

        return {
            x: commandPosition.x - envRight,
            y: commandCenterY - envCenterY
        };
    };

    const isWithinConnectionRange = (distance) => {
        const delta = getConnectionDelta();
        return Math.abs(delta.x) <= distance && Math.abs(delta.y) <= distance;
    };

    const setConnectionFeedback = (available) => {
        workflowCanvas?.classList.toggle("is-connection-available", available);
        workflowCommandBlock?.classList.toggle("is-connection-available", available);
    };

    const disconnectCommand = (moveToDefaultPosition) => {
        markDisconnected();

        if (moveToDefaultPosition) {
            const position = getDefaultCommandPosition();
            setCommandPosition(position.x, position.y);
        }

        updateRunButton();
        clearResult();
    };

    const snapCommand = () => {
        if (!activeCommand || !workflowEnvBlock || !workflowCommandBlock) {
            return;
        }

        const x = workflowEnvBlock.offsetLeft + workflowEnvBlock.offsetWidth;
        const y = workflowEnvBlock.offsetTop + ((workflowEnvBlock.offsetHeight - workflowCommandBlock.offsetHeight) / 2);

        workflowCommandBlock.classList.add("is-snapping");
        setCommandPosition(x, y);
        setConnectionState(activeEnvironment.id, activeCommand.id, "connected");
        setConnectionClasses(true);
        window.setTimeout(() => workflowCommandBlock.classList.remove("is-snapping"), 190);
        updateRunButton();
        clearResult();
    };

    const updateEnvironment = (environment, autoConnect = false) => {
        activeEnvironment = environment;

        envButtons.forEach((button) => {
            button.classList.toggle("is-active", button.dataset.env === activeEnvironment.id);
        });

        if (workflowEnvBlock) {
            workflowEnvBlock.dataset.env = activeEnvironment.id;
        }

        if (workflowEnvName) {
            workflowEnvName.textContent = activeEnvironment.id;
        }

        if (workflowEnvNote) {
            workflowEnvNote.textContent = activeEnvironment.note;
        }

        if (autoConnect && activeCommand) {
            markDisconnected();
            snapCommand();
            return;
        }

        disconnectCommand(true);
    };

    const renderCommand = (command, autoConnect = false) => {
        if (!command || !workflowCommandBlock) {
            return;
        }

        activeCommand = command;
        workflowCommandBlock.dataset.command = command.id;
        workflowCommandBlock.className = `workflow-command-block ${command.tone} is-disconnected`;
        workflowCommandTitle.textContent = command.title;

        if (workflowCommandParams) {
            workflowCommandParams.innerHTML = command.parameterNames.map((paramName) => `
                <label class="workflow-command-input-label">
                    <span>${escapeHtml(paramName)}</span>
                    <input type="text" data-param-name="${escapeHtml(paramName)}" aria-label="${escapeHtml(paramName)}">
                </label>
            `).join("");
        }

        if (autoConnect) {
            snapCommand();
            return;
        }

        disconnectCommand(true);
    };

    const buildTable = (headers, rows) => `
        <table class="result-table">
            <thead>
                <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
            </thead>
            <tbody>
                ${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell ?? "")}</td>`).join("")}</tr>`).join("")}
            </tbody>
        </table>
    `;

    const collectParameterValues = () => {
        const values = {};
        workflowCommandParams?.querySelectorAll("[data-param-name]").forEach((input) => {
            values[input.dataset.paramName] = input.value;
        });
        return values;
    };

    // Resolves to a Response with the same JSON body POST /execute used to return.
    const executeCommand = async (environmentId, sqlId, parameters) => mockApi.execution.execute({
        environmentId: Number(environmentId),
        sqlId: Number(sqlId),
        parameters
    });

    envButtons.forEach((button) => {
        button.addEventListener("click", () => {
            updateEnvironment(getEnvironmentFromButton(button), true);
        });

        button.addEventListener("dragover", (event) => {
            event.preventDefault();
            button.classList.add("is-drag-over");
        });

        button.addEventListener("dragleave", () => {
            button.classList.remove("is-drag-over");
        });

        button.addEventListener("drop", (event) => {
            event.preventDefault();
            button.classList.remove("is-drag-over");
            updateEnvironment(getEnvironmentFromButton(button));
        });
    });

    commandBlocks.forEach((commandBlock) => {
        commandBlock.addEventListener("click", () => {
            renderCommand(commandsById.get(commandBlock.dataset.command), true);
        });

        commandBlock.addEventListener("dragstart", (event) => {
            event.dataTransfer.setData("text/plain", commandBlock.dataset.command);
            event.dataTransfer.effectAllowed = "copy";
            commandBlock.classList.add("is-dragging");
        });

        commandBlock.addEventListener("dragend", () => {
            commandBlock.classList.remove("is-dragging");
        });
    });

    workflowCanvas?.addEventListener("dragover", (event) => {
        event.preventDefault();
    });

    workflowCanvas?.addEventListener("drop", (event) => {
        event.preventDefault();

        const command = commandsById.get(event.dataTransfer.getData("text/plain"));
        if (command) {
            renderCommand(command);
        }
    });

    workflowCommandBlock?.addEventListener("pointerdown", (event) => {
        if (event.target.closest("input")) {
            return;
        }

        event.preventDefault();
        workflowCommandBlock.setPointerCapture(event.pointerId);

        const canvasRect = workflowCanvas.getBoundingClientRect();
        dragState = {
            pointerId: event.pointerId,
            offsetX: event.clientX - canvasRect.left - commandPosition.x,
            offsetY: event.clientY - canvasRect.top - commandPosition.y
        };

        workflowCommandBlock.classList.remove("is-snapping");
        workflowCommandBlock.classList.add("is-dragging");
    });

    workflowCommandBlock?.addEventListener("pointermove", (event) => {
        if (!dragState || dragState.pointerId !== event.pointerId) {
            return;
        }

        const canvasRect = workflowCanvas.getBoundingClientRect();
        setCommandPosition(
                event.clientX - canvasRect.left - dragState.offsetX,
                event.clientY - canvasRect.top - dragState.offsetY
        );

        const nearConnection = isWithinConnectionRange(CONNECT_DISTANCE);
        setConnectionFeedback(nearConnection);

        if (connectionState.connectionStatus === "connected" && !isWithinConnectionRange(DISCONNECT_DISTANCE)) {
            disconnectCommand(false);
        }
    });

    workflowCommandBlock?.addEventListener("pointerup", (event) => {
        if (!dragState || dragState.pointerId !== event.pointerId) {
            return;
        }

        workflowCommandBlock.releasePointerCapture(event.pointerId);
        workflowCommandBlock.classList.remove("is-dragging");
        dragState = null;

        if (isWithinConnectionRange(CONNECT_DISTANCE)) {
            snapCommand();
            return;
        }

        disconnectCommand(false);
    });

    workflowCommandBlock?.addEventListener("pointercancel", () => {
        workflowCommandBlock.classList.remove("is-dragging");
        dragState = null;
        setConnectionFeedback(false);
    });

    runButton?.addEventListener("click", async () => {
        if (!activeCommand || !activeEnvironment || connectionState.connectionStatus !== "connected" || !resultOutput) {
            return;
        }

        if (!activeEnvironment.envId || !activeCommand.sqlId) {
            return;
        }

        runButton.disabled = true;
        resultOutput.classList.remove("is-empty");
        resultOutput.textContent = "Running...";

        try {
            const response = await executeCommand(activeEnvironment.envId, activeCommand.sqlId, collectParameterValues());
            const payload = await response.json();

            if (!response.ok) {
                resultOutput.innerHTML = `
                    <div class="result-status">
                        <span>ERROR</span>
                    </div>
                    <p>${escapeHtml(payload.message || "The request could not be completed.")}</p>
                `;
                return;
            }

            if (!payload.success) {
                resultOutput.innerHTML = `
                    <div class="result-status">
                        <span>FAILED</span>
                        <span>${escapeHtml(payload.environmentName ?? "")}</span>
                    </div>
                    <p>${escapeHtml(payload.errorMessage || "The command failed.")}</p>
                `;
                return;
            }

            let resultBody;
            if (payload.rowsAffected !== null && payload.rowsAffected !== undefined) {
                resultBody = `<p>${payload.rowsAffected} row(s) affected.</p>`;
            } else if (payload.rows.length === 0) {
                resultBody = "<p>The query ran successfully and returned no rows.</p>";
            } else {
                resultBody = buildTable(payload.columns, payload.rows);
            }

            resultOutput.innerHTML = `
                <div class="result-status">
                    <span>SUCCESS</span>
                    <span>${escapeHtml(payload.environmentName ?? "")}</span>
                </div>
                ${resultBody}
            `;
        } catch (error) {
            resultOutput.innerHTML = `
                <div class="result-status">
                    <span>ERROR</span>
                </div>
                <p>The command could not be run. Please try again.</p>
            `;
        } finally {
            runButton.disabled = connectionState.connectionStatus !== "connected";
        }
    });

    window.addEventListener("resize", () => {
        if (connectionState.connectionStatus === "connected") {
            snapCommand();
            return;
        }

        setCommandPosition(commandPosition.x, commandPosition.y);
    });

    renderCommand(commandsById.get(commandBlocks[0]?.dataset.command));
    updateEnvironment(activeEnvironment);
}
