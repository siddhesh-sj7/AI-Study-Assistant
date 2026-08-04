(() => {
  const app = window.StudyAssistantApp;

  if (!app || document.body.dataset.page !== "summarizer") {
    return;
  }

  const button = document.getElementById("summarizeBtn");
  const notes = document.getElementById("notesInput");
  const output = document.getElementById("summaryResult");
  const status = document.getElementById("summaryStatus");

  function renderEmptyState() {
    output.innerHTML = `
      <div class="summary-card">
        <h3>Summary output</h3>
        <p class="empty-state">Paste your notes above, then click Summarize to generate key points and a short recap.</p>
      </div>
    `;
  }

  async function summarizeNotes() {
    const text = notes.value.trim();

    if (!text) {
      app.setMessage(status, "Please paste your notes first.", "error");
      return;
    }

    app.setMessage(status, "Summarizing your notes...");
    button.disabled = true;

    try {
      const data = await app.apiRequest("/api/summarize", {
        method: "POST",
        body: JSON.stringify({ notes: text }),
      });

      output.innerHTML = `
        <div class="summary-card">
          <h3>Key points</h3>
          <ul class="summary-list">
            ${data.bullets.map((bullet) => `<li>${app.escapeHtml(bullet)}</li>`).join("")}
          </ul>
        </div>
        <div class="summary-card">
          <h3>Short recap</h3>
          <p>${app.escapeHtml(data.summary)}</p>
        </div>
      `;
      app.setMessage(status, "Summary ready.", "success");
    } catch (error) {
      renderEmptyState();
      app.setMessage(status, error.message, "error");
    } finally {
      button.disabled = false;
    }
  }

  button.addEventListener("click", summarizeNotes);
  renderEmptyState();
})();
