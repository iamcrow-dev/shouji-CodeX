const minimizeButton = document.getElementById("minimize-to-tray-button");
const quitButton = document.getElementById("quit-app-button");

async function choose(action) {
  if (!window.closeDialog) {
    return;
  }

  await window.closeDialog.choose(action);
}

minimizeButton?.addEventListener("click", () => {
  choose("tray");
});

quitButton?.addEventListener("click", () => {
  choose("exit");
});
