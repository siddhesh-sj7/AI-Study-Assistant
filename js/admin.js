(() => {
  const app = window.StudyAssistantApp;

  if (!app || document.body.dataset.page !== "admin") {
    return;
  }

  const status = document.getElementById("adminStatus");
  const totalUsers = document.getElementById("totalUsers");
  const storageMode = document.getElementById("storageMode");
  const aiMode = document.getElementById("aiMode");
  const latestUser = document.getElementById("latestUser");
  const backendSource = document.getElementById("backendSource");
  const usersTable = document.getElementById("usersTableBody");

  function formatDate(value) {
    if (!value) {
      return "Not available";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  async function loadAdminOverview() {
    app.setMessage(status, "Loading backend overview...");

    try {
      const data = await app.apiRequest("/api/admin/overview");
      const stats = data.stats || {};
      const users = Array.isArray(data.users) ? data.users : [];

      app.animateCount(totalUsers, Number(stats.totalUsers ?? 0));
      storageMode.textContent = stats.storageMode || "Unknown";
      aiMode.textContent = `${stats.aiProvider || "Unknown"}${stats.model ? ` - ${stats.model}` : ""}`;
      latestUser.textContent = stats.latestUser
        ? `${stats.latestUser.name} (${stats.latestUser.email})`
        : "No users registered yet";
      backendSource.textContent = stats.usersFile || "MongoDB collection";

      usersTable.innerHTML = users.length
        ? users
            .map(
              (user, index) => `
                <tr>
                  <td>${index + 1}</td>
                  <td>${app.escapeHtml(user.name)}</td>
                  <td>${app.escapeHtml(user.email)}</td>
                  <td>${app.escapeHtml(formatDate(user.createdAt))}</td>
                </tr>
              `
            )
            .join("")
        : `
          <tr>
            <td colspan="4">No registered users yet.</td>
          </tr>
        `;

      app.setMessage(status, "Backend overview ready.", "success");
    } catch (error) {
      app.setMessage(status, error.message, "error");
    }
  }

  loadAdminOverview();
})();
