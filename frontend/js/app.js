function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value ?? "";
    return div.innerHTML;
}

// Same per-host coloring approach as the High Availability page's
// connectivity test — Ansible's "-m ping" output has one block per host
// starting with "IP | SUCCESS =>" or "IP | UNREACHABLE! =>". Coloring the
// whole block by overall pass/fail would make a successful host's own
// line render in red just because something else in the run failed, so
// this colors each host's block independently instead.
function formatPingOutput(rawOutput) {
    if (!rawOutput.trim()) return "";

    const hostBlockPattern = /^(\S+)\s\|\s(SUCCESS|UNREACHABLE!|FAILED!)/;
    const lines = rawOutput.split("\n");
    const blocks = [];
    let current = null;

    for (const line of lines) {
        const match = line.match(hostBlockPattern);
        if (match) {
            if (current) blocks.push(current);
            current = { status: match[2], lines: [line] };
        } else if (current) {
            current.lines.push(line);
        } else {
            blocks.push({ status: null, lines: [line] });
        }
    }
    if (current) blocks.push(current);

    return blocks.map(block => {
        const text = block.lines.join("\n");
        const cssClass = block.status === "SUCCESS" ? "log-success"
            : (block.status === "UNREACHABLE!" || block.status === "FAILED!") ? "log-error"
            : "";
        return `<pre class="${cssClass}" style="white-space:pre-wrap; margin:6px 0; font-family:inherit;">${escapeHtml(text)}</pre>`;
    }).join("");
}

async function testInstallConnectivity() {
    const payload = {
        server_ip: document.getElementById("server_ip").value.trim(),
        ssh_user: document.getElementById("ssh_user").value.trim(),
        ssh_password: document.getElementById("ssh_password").value
    };

    const statusEl = document.getElementById("connectivity-status");
    const btn = document.getElementById("test-connectivity-btn");

    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Testing...`;
    statusEl.hidden = false;
    statusEl.className = "connection-status";
    statusEl.textContent = "Checking SSH connectivity...";

    try {
        const response = await fetch("/api/install-test-connection", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const result = await response.json();

        statusEl.className = "connection-status";
        statusEl.innerHTML = `<div>${escapeHtml(result.message)}</div>` + formatPingOutput(result.output || "");
    } catch (error) {
        console.error(error);
        statusEl.className = "connection-status log-error";
        statusEl.textContent = "Could not reach the backend to run the connectivity check.";
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-plug-circle-check"></i> Test Connectivity`;
    }
}

function setInstallButtonState(installing) {
    const btn = document.getElementById("install-btn");
    if (!btn) return;
    btn.disabled = installing;
    btn.innerHTML = installing
        ? `<i class="fa-solid fa-spinner fa-spin"></i> Installing...`
        : `<i class="fa-solid fa-download"></i> Install PostgreSQL`;
}

async function installPostgres() {
    const postgresPassword = document.getElementById("postgres_password").value;
    const confirmPassword = document.getElementById("postgres_password_confirm").value;
    const mismatchHint = document.getElementById("password-mismatch-hint");

    if (postgresPassword !== confirmPassword) {
        mismatchHint.style.display = "block";
        return;
    }
    mismatchHint.style.display = "none";

    const deployment = {
        server_ip: document.getElementById("server_ip").value.trim(),
        ssh_user: document.getElementById("ssh_user").value.trim(),
        ssh_password: document.getElementById("ssh_password").value,
        postgres_version: document.getElementById("postgres_version").value,
        postgres_password: postgresPassword
    };

    const status = document.getElementById("status");
    status.textContent = "Starting PostgreSQL deployment...\n";
    setInstallButtonState(true);

    // Start live log polling
    const timer = setInterval(loadDeploymentLog, 2000);

    try {
        const response = await fetch("/api/install", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(deployment)
        });
        clearInterval(timer);

        if (!response.ok) {
            const error = await response.json();
            status.innerHTML = `
                <span class="log-error">❌ ${escapeHtml(error.message)}</span>
                <pre>${escapeHtml(error.stderr || "")}</pre>
            `;
            setInstallButtonState(false);
            return;
        }

        const result = await response.json();

        if (result.status !== "success") {
            status.innerHTML = `
                <span class="log-error">❌ ${escapeHtml(result.message)}</span>
                <pre>${escapeHtml(result.stderr || "")}</pre>
            `;
            setInstallButtonState(false);
            return;
        }

        if (!result.summary || !result.summary.settings) {
            status.innerHTML = `<span class="log-error">Summary file was not generated.</span>`;
            setInstallButtonState(false);
            return;
        }

        // Success — the server now has a real postgres password set (via
        // Ansible), so User Management can connect immediately without
        // anyone SSHing in to run ALTER USER manually. This mirrors the
        // exact shape users/index.html already restores on load.
        sessionStorage.setItem("pgConnection", JSON.stringify({
            server_ip: deployment.server_ip,
            server_port: "5432",
            database: "postgres",
            username: "postgres",
            password: deployment.postgres_password
        }));

        // Hand the install result to the dedicated result page and redirect.
        sessionStorage.setItem("deploymentResult", JSON.stringify(result));
        window.location.href = "result.html";
    }
    catch (error) {
        clearInterval(timer);
        console.error(error);
        status.innerHTML = `
            <span class="log-error">Backend Error</span>
            <pre>${escapeHtml(String(error))}</pre>
        `;
        setInstallButtonState(false);
    }
}

async function loadDeploymentLog() {
    try {
        const response = await fetch("/api/deployment/log");
        if (!response.ok) {
            return;
        }
        const result = await response.json();
        const status = document.getElementById("status");
        status.textContent = result.log;
        // Auto-scroll to latest log
        status.scrollTop = status.scrollHeight;
    }
    catch (error) {
        console.error(error);
    }
}
