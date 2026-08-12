const repoUrlInput = document.getElementById('repoUrl');
const launchBtn = document.getElementById('launchBtn');
const statusBox = document.getElementById('statusBox');
const logOutput = document.getElementById('logOutput');
const inlineSection = document.getElementById('inlineSection');
const inlineFrame = document.getElementById('inlineFrame');
const inlineFullscreenBtn = document.getElementById('inlineFullscreenBtn');

async function toggleInlineFullscreen() {
  if (!inlineFrame) {
    return;
  }

  try {
    if (!document.fullscreenElement) {
      await inlineFrame.requestFullscreen();
      return;
    }
    await document.exitFullscreen();
  } catch (error) {
    statusBox.textContent = 'Fullscreen is blocked by this browser.';
    console.error('Could not toggle fullscreen:', error);
  }
}

if (inlineFullscreenBtn) {
  inlineFullscreenBtn.addEventListener('click', toggleInlineFullscreen);
}

document.addEventListener('fullscreenchange', () => {
  if (!inlineFullscreenBtn) {
    return;
  }

  inlineFullscreenBtn.textContent = document.fullscreenElement ? 'Exit full screen' : 'Fullscreen inline game';
});

async function fetchLogs(repoName) {
  try {
    const response = await fetch(`/api/logs/${encodeURIComponent(repoName)}`);
    if (!response.ok) return;
    const text = await response.text();
    logOutput.textContent = text || 'No output yet.';
  } catch (error) {
    console.error('Could not fetch logs:', error);
  }
}

async function launchRepo() {
  const repoUrl = repoUrlInput.value.trim();

  if (!repoUrl) {
    statusBox.textContent = 'Please enter a GitHub repo URL.';
    return;
  }

  statusBox.textContent = 'Cloning and launching repository...';
  logOutput.textContent = 'Starting launch process...';

  try {
    const response = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl })
    });

    const result = await response.json();

    if (!response.ok) {
      statusBox.textContent = result.error || 'Launch failed.';
      return;
    }

    statusBox.textContent = `Opening a game window for ${result.repoName}...`;
    await fetchLogs(result.repoName);

    const popupUrl = new URL(result.popupUrl, window.location.origin);
    popupUrl.searchParams.set('v', String(Date.now()));

    // Always expose an inline fallback so the game view is still available
    // when popup behavior is blocked or unstable in the browser.
    if (inlineSection && inlineFrame) {
      inlineSection.classList.remove('hidden');
      inlineFrame.src = popupUrl.toString();
    }

    const popup = window.open(popupUrl.toString(), 'gameWindow', 'width=980,height=720,resizable=yes,scrollbars=yes');
    if (!popup) {
      statusBox.textContent = 'Popup was blocked. Using inline game view below.';
    } else {
      statusBox.textContent = `Running ${result.repoName} (${result.status}). Inline fallback is active below.`;
    }
  } catch (error) {
    statusBox.textContent = 'Desktop app could not start the repo.';
    logOutput.textContent = String(error);
  }
}

document.querySelectorAll('.sample-button').forEach((button) => {
  button.addEventListener('click', () => {
    repoUrlInput.value = button.dataset.url;
    launchRepo();
  });
});

launchBtn.addEventListener('click', launchRepo);
