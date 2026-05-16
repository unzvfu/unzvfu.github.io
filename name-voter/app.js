const APP_STORAGE_PREFIX = "name-voter";
const USER_STORAGE_KEY = `${APP_STORAGE_PREFIX}:username`;
const DEFAULT_ROUTE = "overview";
const MAX_APPROVALS = 15;

const state = {
  backendLabel: "Starting",
  roomId: "",
  currentUser: "",
  route: DEFAULT_ROUTE,
  routeUser: "",
  data: {
    roomMeta: null,
    candidates: [],
    comments: [],
    ballots: {},
  },
  editingCandidateId: null,
  unsubscribe: null,
  adapter: null,
  firebaseEnabled: Boolean(window.NAME_VOTER_FIREBASE_CONFIG),
};

const elements = {
  backendStatus: document.querySelector("#backend-status"),
  userChip: document.querySelector("#user-chip"),
  roomTitle: document.querySelector("#room-title"),
  roomDescription: document.querySelector("#room-description"),
  topNav: document.querySelector("#top-nav"),
  overviewView: document.querySelector("#overview-view"),
  ballotView: document.querySelector("#ballot-view"),
  resultsView: document.querySelector("#results-view"),
  candidateForm: document.querySelector("#candidate-form"),
  candidateName: document.querySelector("#candidate-name"),
  candidateNotes: document.querySelector("#candidate-notes"),
  candidateApproval: document.querySelector("#candidate-approval"),
  candidateCount: document.querySelector("#candidate-count"),
  candidateList: document.querySelector("#candidate-list"),
  participantList: document.querySelector("#participant-list"),
  approvedList: document.querySelector("#approved-list"),
  notApprovedList: document.querySelector("#not-approved-list"),
  ballotTitle: document.querySelector("#ballot-title"),
  ballotModeLabel: document.querySelector("#ballot-mode-label"),
  approvalSummary: document.querySelector("#approval-summary"),
  approvalResults: document.querySelector("#approval-results"),
  participationSummary: document.querySelector("#participation-summary"),
  shareLinkButton: document.querySelector("#share-link-button"),
  changeRoomButton: document.querySelector("#change-room-button"),
  identityModal: document.querySelector("#identity-modal"),
  identityForm: document.querySelector("#identity-form"),
  usernameInput: document.querySelector("#username-input"),
  roomModal: document.querySelector("#room-modal"),
  createRoomButton: document.querySelector("#create-room-button"),
  joinRoomForm: document.querySelector("#join-room-form"),
  roomTokenInput: document.querySelector("#room-token-input"),
};

start().catch((error) => {
  console.error(error);
  updateBackendStatus("Error loading app");
  window.alert("The app failed to load. Check the browser console for details.");
});

async function start() {
  state.currentUser = sessionStorage.getItem(USER_STORAGE_KEY) || "";
  bindEvents();
  parseLocation();
  if (!state.currentUser) {
    ensureIdentity();
    render();
    return;
  }
  await connectToRoom();
}

function bindEvents() {
  window.addEventListener("hashchange", () => {
    parseLocation();
    render();
  });

  window.addEventListener("popstate", async () => {
    parseLocation();
    await connectToRoom();
  });

  elements.topNav.addEventListener("click", (event) => {
    const button = event.target.closest("[data-route]");
    if (!button) {
      return;
    }
    navigateTo(button.dataset.route);
  });

  elements.identityForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const username = normalizeUsername(elements.usernameInput.value);
    if (!username) {
      window.alert("Choose a username first.");
      return;
    }
    state.currentUser = username;
    sessionStorage.setItem(USER_STORAGE_KEY, username);
    elements.identityModal.close();
    if (!state.roomId) {
      promptForRoom();
    } else {
      connectToRoom().catch((error) => {
        console.error(error);
        window.alert("Unable to connect to that room.");
      });
    }
    render();
  });

  elements.createRoomButton.addEventListener("click", async () => {
    setRoomToken(generateToken());
    elements.roomModal.close();
    await connectToRoom();
  });

  elements.joinRoomForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = normalizeRoomToken(elements.roomTokenInput.value);
    if (!token) {
      window.alert("Paste a valid room token.");
      return;
    }
    setRoomToken(token);
    elements.roomModal.close();
    await connectToRoom();
  });

  elements.candidateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.currentUser) {
      ensureIdentity();
      return;
    }
    const name = elements.candidateName.value.trim();
    if (!name) {
      window.alert("Candidate names cannot be empty.");
      return;
    }
    try {
      const approve = elements.candidateApproval.value === "yes";
      const currentApprovals = getApprovedCandidateIdsForUser(state.currentUser);
      if (approve && currentApprovals.length >= MAX_APPROVALS) {
        window.alert(`You can only approve up to ${MAX_APPROVALS} names.`);
        return;
      }
      await state.adapter.createCandidateAndVote({
        name,
        notes: elements.candidateNotes.value.trim(),
        approve,
        user: state.currentUser,
        currentApprovals,
      });
      elements.candidateForm.reset();
      elements.candidateApproval.value = "no";
    } catch (error) {
      console.error(error);
      window.alert("Unable to add that candidate.");
    }
  });

  elements.shareLinkButton.addEventListener("click", async () => {
    if (!state.roomId) {
      promptForRoom();
      return;
    }
    const shareUrl = getShareUrl();
    try {
      await navigator.clipboard.writeText(shareUrl);
      window.alert("Secret link copied to clipboard.");
    } catch (error) {
      console.error(error);
      window.prompt("Copy this room link:", shareUrl);
    }
  });

  elements.changeRoomButton.addEventListener("click", () => {
    promptForRoom();
  });

  elements.candidateList.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]");
    if (!action) {
      return;
    }
    const candidateId = action.dataset.candidateId;
    if (action.dataset.action === "toggle-edit") {
      state.editingCandidateId =
        state.editingCandidateId === candidateId ? null : candidateId;
      render();
      return;
    }
    if (action.dataset.action === "delete-candidate") {
      const candidate = state.data.candidates.find((entry) => entry.id === candidateId);
      if (!candidate || candidate.createdBy !== state.currentUser) {
        return;
      }
      const confirmed = window.confirm(
        `Delete "${candidate.name}"? This also removes its comments.`,
      );
      if (!confirmed) {
        return;
      }
      try {
        await state.adapter.deleteCandidate(candidateId);
        if (state.editingCandidateId === candidateId) {
          state.editingCandidateId = null;
        }
      } catch (error) {
        console.error(error);
        window.alert("Unable to delete that candidate.");
      }
      return;
    }
    if (action.dataset.action === "save-candidate") {
      const form = action.closest("form");
      const payload = new FormData(form);
      const name = String(payload.get("name") || "").trim();
      if (!name) {
        window.alert("Candidate names cannot be empty.");
        return;
      }
      try {
        await state.adapter.updateCandidate(candidateId, {
          name,
          notes: String(payload.get("notes") || "").trim(),
          updatedBy: state.currentUser,
        });
        state.editingCandidateId = null;
      } catch (error) {
        console.error(error);
        window.alert("Unable to save that candidate.");
      }
      return;
    }
    if (action.dataset.action === "add-comment") {
      const form = action.closest("form");
      const input = form.querySelector('textarea[name="comment"]');
      const text = input.value.trim();
      if (!text) {
        return;
      }
      try {
        await state.adapter.addComment(candidateId, {
          author: state.currentUser,
          text,
        });
        form.reset();
      } catch (error) {
        console.error(error);
        window.alert("Unable to add that comment.");
      }
    }
  });

  elements.ballotView.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-vote-action]");
    if (!action) {
      return;
    }
    const ballotUser = getActiveBallotUsername();
    if (ballotUser !== state.currentUser) {
      return;
    }
    const candidateId = action.dataset.candidateId;
    const approvals = [...getApprovedCandidateIdsForUser(ballotUser)];
    let nextApprovals = approvals;
    switch (action.dataset.voteAction) {
      case "approve":
        if (approvals.includes(candidateId)) {
          return;
        }
        if (approvals.length >= MAX_APPROVALS) {
          window.alert(`You can only approve up to ${MAX_APPROVALS} names.`);
          return;
        }
        nextApprovals = [...approvals, candidateId];
        break;
      case "reject":
        nextApprovals = approvals.filter((id) => id !== candidateId);
        break;
      default:
        return;
    }
    try {
      await state.adapter.saveBallot(ballotUser, nextApprovals);
    } catch (error) {
      console.error(error);
      window.alert("Unable to save that ballot.");
    }
  });
}

function ensureIdentity() {
  if (state.currentUser) {
    return;
  }
  elements.usernameInput.value = "";
  if (!elements.identityModal.open) {
    elements.identityModal.showModal();
  }
}

function promptForRoom() {
  elements.roomTokenInput.value = state.roomId;
  if (!elements.roomModal.open) {
    elements.roomModal.showModal();
  }
}

function parseLocation() {
  const url = new URL(window.location.href);
  state.roomId = normalizeRoomToken(url.searchParams.get("room") || "");
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) {
    state.route = DEFAULT_ROUTE;
    state.routeUser = "";
    return;
  }
  const [route, maybeUser] = hash.split("/");
  state.route = route || DEFAULT_ROUTE;
  state.routeUser = normalizeUsername(maybeUser || "");
}

function setRoomToken(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  window.history.pushState({}, "", url);
  parseLocation();
}

function navigateTo(route) {
  const normalizedRoute = route || DEFAULT_ROUTE;
  window.location.hash = normalizedRoute;
}

async function connectToRoom() {
  if (!state.currentUser) {
    ensureIdentity();
    render();
    return;
  }
  if (state.unsubscribe) {
    state.unsubscribe();
    state.unsubscribe = null;
  }
  if (!state.roomId) {
    promptForRoom();
    render();
    return;
  }

  updateBackendStatus("Connecting");
  state.adapter = state.firebaseEnabled
    ? await createFirestoreAdapter(window.NAME_VOTER_FIREBASE_CONFIG)
    : createLocalAdapter();

  state.unsubscribe = await state.adapter.subscribe(
    state.roomId,
    state.currentUser,
    (nextData) => {
      state.data = nextData;
      render();
    },
  );

  updateBackendStatus(
    state.firebaseEnabled ? "Live sync via Firestore" : "Demo mode: local browser storage",
  );
  render();
}

function render() {
  elements.userChip.textContent = state.currentUser
    ? `User: ${state.currentUser}`
    : "No username yet";
  elements.roomTitle.textContent = state.roomId
    ? `Room ${state.roomId}`
    : "No room selected";
  elements.roomDescription.textContent = state.firebaseEnabled
    ? "Everyone with this exact link can join the same shared room."
    : "This room is running locally in your browser until Firebase is configured.";

  const route = resolveRoute();
  for (const button of elements.topNav.querySelectorAll("[data-route]")) {
    button.classList.toggle("active", button.dataset.route === route.baseRoute);
  }
  elements.overviewView.classList.toggle("hidden", route.baseRoute !== "overview");
  elements.ballotView.classList.toggle("hidden", route.baseRoute !== "ballot");
  elements.resultsView.classList.toggle("hidden", route.baseRoute !== "results");

  renderOverview();
  renderBallot();
  renderResults();
}

function resolveRoute() {
  if (state.route === "ballot") {
    return {
      baseRoute: "ballot",
      ballotUser: state.routeUser || state.currentUser,
    };
  }
  if (state.route === "results") {
    return { baseRoute: "results", ballotUser: "" };
  }
  return { baseRoute: "overview", ballotUser: "" };
}

function renderOverview() {
  const candidates = getCandidatesSorted();
  elements.candidateCount.textContent = `${candidates.length} candidate${
    candidates.length === 1 ? "" : "s"
  }`;

  if (candidates.length === 0) {
    elements.candidateList.innerHTML =
      '<div class="empty-state">No names yet. Add the first candidate above.</div>';
  } else {
    elements.candidateList.innerHTML = candidates
      .map((candidate) => renderCandidateCard(candidate))
      .join("");
  }

  const participants = getParticipantUsernames();
  if (participants.length === 0) {
    elements.participantList.innerHTML =
      '<div class="empty-state">No votes yet. Votes appear here after someone approves a name.</div>';
    return;
  }
  elements.participantList.innerHTML = participants
    .map((username) => {
      const approvals = getApprovedCandidateIdsForUser(username).length;
      return `
        <div class="participant-item">
          <div>
            <strong>${escapeHtml(username)}</strong>
            <p class="helper-text">${approvals} approval${approvals === 1 ? "" : "s"} used</p>
          </div>
          <a class="participant-link" href="#ballot/${encodeURIComponent(username)}">View votes</a>
        </div>
      `;
    })
    .join("");
}

function renderCandidateCard(candidate) {
  const comments = getCommentsForCandidate(candidate.id);
  const editing = state.editingCandidateId === candidate.id;
  const notesText = getCandidateNotes(candidate);
  const canDelete = candidate.createdBy === state.currentUser;

  return `
    <article class="candidate-card">
      <div class="candidate-topline">
        <div>
          <h4>${escapeHtml(candidate.name)}</h4>
          <p class="helper-text">Added by ${escapeHtml(candidate.createdBy || "unknown")}</p>
        </div>
        <button
          class="mini-button secondary"
          type="button"
          data-action="toggle-edit"
          data-candidate-id="${candidate.id}"
        >
          ${editing ? "Close editor" : "Edit details"}
        </button>
        ${
          canDelete
            ? `
              <button
                class="mini-button secondary"
                type="button"
                data-action="delete-candidate"
                data-candidate-id="${candidate.id}"
              >
                Delete
              </button>
            `
            : ""
        }
      </div>
      <p>${escapeHtml(notesText || "No notes yet.")}</p>
      ${
        editing
          ? `
            <form class="stack-sm card-actions">
              <label class="field">
                <span>Name</span>
                <input name="name" required maxlength="120" value="${escapeAttribute(candidate.name)}" />
              </label>
              <label class="field">
                <span>Notes</span>
                <textarea name="notes" rows="4">${escapeHtml(notesText)}</textarea>
              </label>
              <div class="form-actions">
                <button
                  class="button"
                  type="button"
                  data-action="save-candidate"
                  data-candidate-id="${candidate.id}"
                >
                  Save Candidate
                </button>
              </div>
            </form>
          `
          : ""
      }
      <div class="candidate-meta">
        <span class="meta-label">${comments.length} comment${comments.length === 1 ? "" : "s"}</span>
      </div>
      <div class="comment-list">
        ${
          comments.length === 0
            ? '<div class="empty-state">No comments yet.</div>'
            : comments
                .map(
                  (comment) => `
                    <div class="comment-item">
                      <div>
                        <div class="comment-author">${escapeHtml(comment.author)}</div>
                        <div>${escapeHtml(comment.text)}</div>
                      </div>
                      <div class="meta-label">${formatDate(comment.createdAtMs)}</div>
                    </div>
                  `,
                )
                .join("")
        }
      </div>
      <form class="stack-sm card-actions">
        <label class="field">
          <span>Add comment</span>
          <textarea name="comment" rows="2" placeholder="Share feedback on this name"></textarea>
        </label>
        <div class="form-actions">
          <button
            class="button secondary"
            type="button"
            data-action="add-comment"
            data-candidate-id="${candidate.id}"
          >
            Post Comment
          </button>
        </div>
      </form>
    </article>
  `;
}

function renderBallot() {
  const ballotUser = getActiveBallotUsername();
  const isOwner = ballotUser === state.currentUser;
  const approvedCandidates = getApprovedCandidatesForUser(ballotUser);
  const notApprovedCandidates = getNotApprovedCandidatesForUser(ballotUser);
  const approvalsUsed = approvedCandidates.length;

  elements.ballotTitle.textContent = isOwner
    ? "My approval votes"
    : `${ballotUser || "Unknown"}'s votes`;
  elements.ballotModeLabel.textContent = isOwner
    ? `Only you can edit these votes from the UI. ${approvalsUsed}/${MAX_APPROVALS} approvals used.`
    : "Read only. Votes can only be edited by the matching username in this browser session.";

  elements.approvedList.innerHTML =
    approvedCandidates.length === 0
      ? '<div class="empty-state">No approved names yet.</div>'
      : approvedCandidates.map((candidate) => renderApprovedBallotItem(candidate, isOwner)).join("");

  elements.notApprovedList.innerHTML =
    notApprovedCandidates.length === 0
      ? '<div class="empty-state">All current names are approved.</div>'
      : notApprovedCandidates
          .map((candidate) => renderNotApprovedBallotItem(candidate, isOwner, approvalsUsed))
          .join("");
}

function renderApprovedBallotItem(candidate, isOwner) {
  return `
    <article class="ballot-item">
      <div class="ballot-topline">
        <div class="stack-sm" style="flex: 1">
          <h4>${escapeHtml(candidate.name)}</h4>
          <p class="helper-text">${escapeHtml(candidate.notes || "No notes")}</p>
        </div>
      </div>
      ${
        isOwner
          ? `
            <div class="mini-actions">
              <button class="mini-button secondary" type="button" data-vote-action="reject" data-candidate-id="${candidate.id}">Vote No</button>
            </div>
          `
          : ""
      }
    </article>
  `;
}

function renderNotApprovedBallotItem(candidate, isOwner, approvalsUsed) {
  return `
    <article class="ballot-item">
      <div class="ballot-topline">
        <div class="stack-sm" style="flex: 1">
          <h4>${escapeHtml(candidate.name)}</h4>
          <p class="helper-text">${escapeHtml(candidate.notes || "No notes")}</p>
        </div>
      </div>
      ${
        isOwner
          ? `
            <div class="mini-actions">
              <button class="mini-button" type="button" data-vote-action="approve" data-candidate-id="${candidate.id}" ${
                approvalsUsed >= MAX_APPROVALS ? "disabled" : ""
              }>Vote Yes</button>
            </div>
          `
          : ""
      }
    </article>
  `;
}

function renderResults() {
  const candidates = getCandidatesSorted();
  const ballots = getParticipantUsernames().map((username) => ({
    username,
    approvals: getApprovedCandidateIdsForUser(username),
  }));

  const results = computeApprovalResults(candidates, ballots);

  if (candidates.length === 0) {
    elements.approvalSummary.innerHTML =
      '<div class="empty-state">Add candidates before looking at results.</div>';
    elements.approvalResults.innerHTML = "";
    elements.participationSummary.innerHTML = "";
    return;
  }

  elements.approvalSummary.innerHTML = `
    <div class="summary-tile">
      <div class="meta-label">Top name</div>
      <p class="summary-value">${escapeHtml(results.topName)}</p>
    </div>
    <div class="summary-tile">
      <div class="meta-label">Participants</div>
      <p class="summary-value">${results.ballotsCounted}</p>
    </div>
    <div class="summary-tile">
      <div class="meta-label">Names shown</div>
      <p class="summary-value">${results.rows.length}</p>
    </div>
  `;

  elements.approvalResults.innerHTML = results.rows
    .map(
      (row, index) => `
        <div class="result-row">
          <div>
            <strong>${index + 1}. ${escapeHtml(row.name)}</strong>
          </div>
          <span class="result-score">${row.votes} approval${row.votes === 1 ? "" : "s"}</span>
        </div>
      `,
    )
    .join("");

  const participants = getParticipantUsernames();
  const totalApprovals = participants.reduce(
    (sum, username) => sum + getApprovedCandidateIdsForUser(username).length,
    0,
  );
  elements.participationSummary.innerHTML = `
    <div class="summary-tile">
      <div class="meta-label">Participants</div>
      <p class="summary-value">${participants.length}</p>
    </div>
    <div class="summary-tile">
      <div class="meta-label">Candidates</div>
      <p class="summary-value">${candidates.length}</p>
    </div>
    <div class="summary-tile">
      <div class="meta-label">Total approvals cast</div>
      <p class="summary-value">${totalApprovals}</p>
    </div>
    <div class="summary-tile">
      <div class="meta-label">Approval limit</div>
      <p class="summary-value">${MAX_APPROVALS} per person</p>
    </div>
  `;
}

function updateBackendStatus(text) {
  state.backendLabel = text;
  elements.backendStatus.textContent = text;
}

function getShareUrl() {
  const url = new URL(window.location.href);
  url.hash = "#overview";
  return url.toString();
}

function getCandidatesSorted() {
  return [...state.data.candidates].sort(compareCandidates);
}

function compareCandidates(left, right) {
  const timeDelta = Number(left.createdAtMs || 0) - Number(right.createdAtMs || 0);
  if (timeDelta !== 0) {
    return timeDelta;
  }
  return left.name.localeCompare(right.name);
}

function getParticipantUsernames() {
  const usernames = new Set(Object.keys(state.data.ballots || {}));
  if (state.currentUser) {
    usernames.add(state.currentUser);
  }
  return [...usernames].sort((left, right) => left.localeCompare(right));
}

function getApprovedCandidateIdsForUser(username) {
  const ballot = state.data.ballots?.[username];
  const candidateIds = new Set(state.data.candidates.map((candidate) => candidate.id));
  return getBallotApprovals(ballot).filter((candidateId) => candidateIds.has(candidateId));
}

function getBallotApprovals(ballot) {
  if (!ballot) {
    return [];
  }
  const rawApprovals = Array.isArray(ballot.approvals)
    ? ballot.approvals
    : Array.isArray(ballot.rankings)
      ? ballot.rankings.slice(0, MAX_APPROVALS)
      : [];
  return [...new Set(rawApprovals)].slice(0, MAX_APPROVALS);
}

function getApprovedCandidatesForUser(username) {
  const candidateMap = new Map(state.data.candidates.map((candidate) => [candidate.id, candidate]));
  return getApprovedCandidateIdsForUser(username)
    .map((candidateId) => candidateMap.get(candidateId))
    .filter(Boolean);
}

function getNotApprovedCandidatesForUser(username) {
  const approvedIds = new Set(getApprovedCandidateIdsForUser(username));
  return getCandidatesSorted().filter((candidate) => !approvedIds.has(candidate.id));
}

function getCommentsForCandidate(candidateId) {
  return state.data.comments
    .filter((comment) => comment.candidateId === candidateId)
    .sort((left, right) => Number(left.createdAtMs || 0) - Number(right.createdAtMs || 0));
}

function getCandidateNotes(candidate) {
  const notes = String(candidate.notes || "").trim();
  const legacyLinks = Array.isArray(candidate.links) ? candidate.links.filter(Boolean) : [];
  if (legacyLinks.length === 0) {
    return notes;
  }
  return [notes, ...legacyLinks].filter(Boolean).join("\n");
}

function getActiveBallotUsername() {
  return resolveRoute().ballotUser || state.currentUser;
}

function computeApprovalResults(candidates, ballots) {
  const counts = new Map(candidates.map((candidate) => [candidate.id, 0]));
  for (const ballot of ballots) {
    for (const candidateId of ballot.approvals) {
      if (counts.has(candidateId)) {
        counts.set(candidateId, counts.get(candidateId) + 1);
      }
    }
  }
  const rows = candidates
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      votes: counts.get(candidate.id) || 0,
    }))
    .sort((left, right) => right.votes - left.votes || left.name.localeCompare(right.name))
    .slice(0, 5);
  return {
    rows,
    ballotsCounted: ballots.length,
    topName: rows[0]?.name || "No approvals yet",
  };
}

function normalizeUsername(value) {
  return value.trim().replace(/\s+/g, "-").slice(0, 60);
}

function normalizeRoomToken(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
}

function generateToken() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let output = "";
  for (let index = 0; index < 24; index += 1) {
    const randomIndex = Math.floor(Math.random() * alphabet.length);
    output += alphabet[randomIndex];
  }
  return output;
}

function formatDate(createdAtMs) {
  if (!createdAtMs) {
    return "Just now";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(createdAtMs));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function createLocalAdapter() {
  const listeners = new Set();
  let roomId = "";

  function readRoom() {
    const raw = localStorage.getItem(storageKey(roomId));
    if (!raw) {
      return {
        roomMeta: { roomId },
        candidates: [],
        comments: [],
        ballots: {},
      };
    }
    return JSON.parse(raw);
  }

  function writeRoom(data) {
    localStorage.setItem(storageKey(roomId), JSON.stringify(data));
    emit();
  }

  function emit() {
    const payload = readRoom();
    for (const listener of listeners) {
      listener(payload);
    }
  }

  window.addEventListener("storage", (event) => {
    if (event.key === storageKey(roomId)) {
      emit();
    }
  });

  return {
    async subscribe(nextRoomId, currentUser, onChange) {
      roomId = nextRoomId;
      listeners.add(onChange);
      const data = readRoom();
      if (!data.ballots[currentUser]) {
        data.ballots[currentUser] = {
          username: currentUser,
          approvals: [],
          updatedAtMs: Date.now(),
        };
        writeRoom(data);
      } else {
        onChange(data);
      }
      return () => {
        listeners.delete(onChange);
      };
    },
    async createCandidateAndVote(payload) {
      const data = readRoom();
      const candidateId = createId();
      data.candidates.push({
        id: candidateId,
        name: payload.name,
        notes: payload.notes,
        createdBy: payload.user,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      data.ballots[payload.user] = {
        username: payload.user,
        approvals: payload.approve
          ? [...payload.currentApprovals, candidateId].slice(0, MAX_APPROVALS)
          : payload.currentApprovals,
        updatedAtMs: Date.now(),
      };
      writeRoom(data);
    },
    async updateCandidate(candidateId, patch) {
      const data = readRoom();
      const candidate = data.candidates.find((entry) => entry.id === candidateId);
      if (!candidate) {
        return;
      }
      candidate.name = patch.name;
      candidate.notes = patch.notes;
      candidate.links = [];
      candidate.updatedBy = patch.updatedBy;
      candidate.updatedAtMs = Date.now();
      writeRoom(data);
    },
    async deleteCandidate(candidateId) {
      const data = readRoom();
      data.candidates = data.candidates.filter((entry) => entry.id !== candidateId);
      data.comments = data.comments.filter((entry) => entry.candidateId !== candidateId);
      writeRoom(data);
    },
    async addComment(candidateId, payload) {
      const data = readRoom();
      data.comments.push({
        id: createId(),
        candidateId,
        author: payload.author,
        text: payload.text,
        createdAtMs: Date.now(),
      });
      writeRoom(data);
    },
    async saveBallot(username, approvals) {
      const data = readRoom();
      data.ballots[username] = {
        username,
        approvals: approvals.slice(0, MAX_APPROVALS),
        updatedAtMs: Date.now(),
      };
      writeRoom(data);
    },
  };
}

async function createFirestoreAdapter(config) {
  const { initializeApp } = await import(
    "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js"
  );
  const {
    getDoc,
    getFirestore,
    collection,
    doc,
    onSnapshot,
    query,
    orderBy,
    setDoc,
    updateDoc,
    writeBatch,
  } = await import("https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js");

  const app = initializeApp(config);
  const db = getFirestore(app);

  function roomRef(roomId) {
    return doc(db, "rooms", roomId);
  }

  return {
    async subscribe(roomId, currentUser, onChange) {
      const currentState = {
        roomMeta: { roomId },
        candidates: [],
        comments: [],
        ballots: {},
      };

      await setDoc(
        roomRef(roomId),
        {
          roomId,
          createdAtMs: Date.now(),
          touchedAtMs: Date.now(),
        },
        { merge: true },
      );

      const ballotRef = doc(db, "rooms", roomId, "ballots", currentUser);
      const ballotSnapshot = await getDoc(ballotRef);
      if (!ballotSnapshot.exists()) {
        await setDoc(ballotRef, {
          username: currentUser,
          approvals: [],
          updatedAtMs: Date.now(),
        });
      }

      const unsubscribers = [
        onSnapshot(
          query(collection(db, "rooms", roomId, "candidates"), orderBy("createdAtMs", "asc")),
          (snapshot) => {
            currentState.candidates = snapshot.docs.map((entry) => ({
              id: entry.id,
              ...entry.data(),
            }));
            onChange(structuredClone(currentState));
          },
        ),
        onSnapshot(
          query(collection(db, "rooms", roomId, "comments"), orderBy("createdAtMs", "asc")),
          (snapshot) => {
            currentState.comments = snapshot.docs.map((entry) => ({
              id: entry.id,
              ...entry.data(),
            }));
            onChange(structuredClone(currentState));
          },
        ),
        onSnapshot(collection(db, "rooms", roomId, "ballots"), (snapshot) => {
          const ballots = {};
          for (const entry of snapshot.docs) {
            ballots[entry.id] = { username: entry.id, ...entry.data() };
          }
          currentState.ballots = ballots;
          onChange(structuredClone(currentState));
        }),
      ];

      return () => {
        unsubscribers.forEach((unsubscribe) => unsubscribe());
      };
    },
    async createCandidateAndVote(payload) {
      const candidateId = createId();
      const batch = writeBatch(db);
      batch.set(doc(db, "rooms", state.roomId, "candidates", candidateId), {
        name: payload.name,
        notes: payload.notes,
        createdBy: payload.user,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      batch.set(
        doc(db, "rooms", state.roomId, "ballots", payload.user),
        {
          username: payload.user,
          approvals: payload.approve
            ? [...payload.currentApprovals, candidateId].slice(0, MAX_APPROVALS)
            : payload.currentApprovals,
          updatedAtMs: Date.now(),
        },
        { merge: true },
      );
      batch.set(
        roomRef(state.roomId),
        {
          touchedAtMs: Date.now(),
        },
        { merge: true },
      );
      await batch.commit();
    },
    async updateCandidate(candidateId, patch) {
      await updateDoc(doc(db, "rooms", state.roomId, "candidates", candidateId), {
        name: patch.name,
        notes: patch.notes,
        links: [],
        updatedAtMs: Date.now(),
        updatedBy: patch.updatedBy,
      });
    },
    async deleteCandidate(candidateId) {
      const batch = writeBatch(db);
      batch.delete(doc(db, "rooms", state.roomId, "candidates", candidateId));
      for (const comment of state.data.comments.filter((entry) => entry.candidateId === candidateId)) {
        batch.delete(doc(db, "rooms", state.roomId, "comments", comment.id));
      }
      batch.set(
        roomRef(state.roomId),
        {
          touchedAtMs: Date.now(),
        },
        { merge: true },
      );
      await batch.commit();
    },
    async addComment(candidateId, payload) {
      await setDoc(doc(db, "rooms", state.roomId, "comments", createId()), {
        candidateId,
        author: payload.author,
        text: payload.text,
        createdAtMs: Date.now(),
      });
    },
    async saveBallot(username, approvals) {
      await setDoc(
        doc(db, "rooms", state.roomId, "ballots", username),
        {
          username,
          approvals: approvals.slice(0, MAX_APPROVALS),
          updatedAtMs: Date.now(),
        },
        { merge: true },
      );
    },
  };
}

function storageKey(roomId) {
  return `${APP_STORAGE_PREFIX}:room:${roomId}`;
}

function createId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
