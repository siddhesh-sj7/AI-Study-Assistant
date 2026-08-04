(() => {
  const app = window.StudyAssistantApp;

  if (!app || document.body.dataset.page !== "quiz") {
    return;
  }

  const topicInput = document.getElementById("quizTopic");
  const generateButton = document.getElementById("generateQuiz");
  const output = document.getElementById("quizResult");
  const status = document.getElementById("quizStatus");

  let currentQuestions = [];

  function renderEmptyState() {
    output.innerHTML = `
      <div class="summary-card">
        <h3>Your quiz will appear here</h3>
        <p class="empty-state">Enter a topic like JavaScript, database management, operating systems, or AI basics to generate 5 MCQs.</p>
      </div>
    `;
  }

  function renderQuiz(questions) {
    output.innerHTML = `
      <form class="quiz-form" id="quizForm">
        <div class="quiz-output">
          ${questions
            .map(
              (question, index) => `
                <section class="quiz-card">
                  <div class="eyebrow">Question ${index + 1}</div>
                  <h3>${app.escapeHtml(question.question)}</h3>
                  <div class="option-list">
                    ${question.options
                      .map(
                        (option, optionIndex) => `
                          <label class="option">
                            <input type="radio" name="question-${index}" value="${optionIndex}" />
                            <span>${app.escapeHtml(option)}</span>
                          </label>
                        `
                      )
                      .join("")}
                  </div>
                  <div class="answer-note" data-answer-note="${index}" hidden></div>
                </section>
              `
            )
            .join("")}
        </div>
        <div class="button-row">
          <button class="button" type="submit">Check Answers</button>
        </div>
        <div id="quizScore"></div>
      </form>
    `;

    const form = document.getElementById("quizForm");

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      let score = 0;

      questions.forEach((question, index) => {
        const choice = form.querySelector(`input[name="question-${index}"]:checked`);
        const note = output.querySelector(`[data-answer-note="${index}"]`);
        const pickedIndex = choice ? Number(choice.value) : -1;
        const correct = pickedIndex === question.answerIndex;

        if (correct) {
          score += 1;
        }

        note.hidden = false;
        note.innerHTML = `
          <strong>${correct ? "Correct" : "Review this one"}</strong><br />
          ${app.escapeHtml(question.explanation)}
        `;
      });

      const scoreTarget = document.getElementById("quizScore");
      scoreTarget.innerHTML = `<div class="quiz-score">Score: ${score} / ${questions.length}</div>`;
      app.setMessage(status, "Quiz checked. Review the explanations below.", "success");
    });
  }

  async function generateQuiz() {
    const topic = topicInput.value.trim();

    if (!topic) {
      app.setMessage(status, "Please enter a topic first.", "error");
      return;
    }

    generateButton.disabled = true;
    app.setMessage(status, "Generating quiz...");

    try {
      const data = await app.apiRequest("/api/quiz", {
        method: "POST",
        body: JSON.stringify({ topic }),
      });

      currentQuestions = Array.isArray(data.questions) ? data.questions : [];
      renderQuiz(currentQuestions);
      app.setMessage(status, "Quiz ready. Answer all 5 questions and check your score.", "success");
    } catch (error) {
      renderEmptyState();
      app.setMessage(status, error.message, "error");
    } finally {
      generateButton.disabled = false;
    }
  }

  generateButton.addEventListener("click", generateQuiz);
  renderEmptyState();
})();
