(() => {
  "use strict";

  const CLIENT_ID =
    "427705878745-u2skb9n2egbgvdebag2kn1mgmf3mbpb0.apps.googleusercontent.com";

  const DRIVE_SCOPE =
    "https://www.googleapis.com/auth/drive.file";

  const APP_FOLDER_NAME =
    "Teacher Dashboard";

  let tokenClient = null;
  let accessToken = "";
  let connectButton = null;

  function setButtonState(text, disabled = false) {
    if (!connectButton) return;

    connectButton.textContent = text;
    connectButton.disabled = disabled;
  }

  function waitForGoogleIdentity() {
    return new Promise((resolve, reject) => {
      const started = Date.now();

      const timer = setInterval(() => {
        if (
          window.google &&
          google.accounts &&
          google.accounts.oauth2
        ) {
          clearInterval(timer);
          resolve();
          return;
        }

        if (Date.now() - started > 10000) {
          clearInterval(timer);
          reject(
            new Error("Google Identity Services did not load.")
          );
        }
      }, 100);
    });
  }

  async function initialize() {
    if (tokenClient) return;

    await waitForGoogleIdentity();

    tokenClient =
      google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: () => {}
      });
  }

  async function driveRequest(url, options = {}) {
    if (!accessToken) {
      throw new Error("Google Drive is not connected.");
    }

    const headers =
      new Headers(options.headers || {});

    headers.set(
      "Authorization",
      `Bearer ${accessToken}`
    );

    const response = await fetch(url, {
      ...options,
      headers
    });

    if (!response.ok) {
      let message =
        `Google Drive error ${response.status}`;

      try {
        const errorData = await response.json();

        message =
          errorData?.error?.message || message;
      } catch (_) {}

      throw new Error(message);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async function findAppFolder() {
    const query = [
      `name = '${APP_FOLDER_NAME}'`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      `trashed = false`
    ].join(" and ");

    const url =
      "https://www.googleapis.com/drive/v3/files" +
      `?q=${encodeURIComponent(query)}` +
      "&spaces=drive" +
      "&fields=files(id,name,mimeType)" +
      "&pageSize=10";

    const result =
      await driveRequest(url);

    return result.files?.[0] || null;
  }

  async function createAppFolder() {
    return driveRequest(
      "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: APP_FOLDER_NAME,
          mimeType:
            "application/vnd.google-apps.folder"
        })
      }
    );
  }

  async function ensureAppFolder() {
    let folder = await findAppFolder();

    if (!folder) {
      folder = await createAppFolder();
    }

    return folder;
  }

  async function finishConnection(tokenResponse) {
    if (tokenResponse.error) {
      throw new Error(tokenResponse.error);
    }

    accessToken =
      tokenResponse.access_token;

    setButtonState("☁ Connecting…", true);

    const folder =
      await ensureAppFolder();

    console.log(
      "Teacher Dashboard Drive folder:",
      folder
    );

    setButtonState("☁ Drive Connected");

    window.dispatchEvent(
      new CustomEvent(
        "teacher-dashboard-drive-connected",
        {
          detail: {
            folderId: folder.id,
            folderName: folder.name
          }
        }
      )
    );

    return folder;
  }

  async function connect() {
    try {
      setButtonState("☁ Connecting…", true);

      await initialize();

      tokenClient.callback =
        async response => {
          try {
            await finishConnection(response);
          } catch (error) {
            console.error(
              "Google Drive connection failed.",
              error
            );

            setButtonState("⚠ Drive Error");

            alert(
              "Google Drive could not be connected:\n\n" +
              error.message
            );
          }
        };

      tokenClient.requestAccessToken({
        prompt: "consent"
      });

    } catch (error) {
      console.error(
        "Google Drive connection failed.",
        error
      );

      setButtonState("⚠ Drive Error");

      alert(
        "Google Drive could not be connected:\n\n" +
        error.message
      );
    }
  }

  function createTestButton() {
    connectButton =
      document.createElement("button");

    connectButton.type = "button";
    connectButton.textContent =
      "☁ Connect Google Drive";

    Object.assign(
      connectButton.style,
      {
        position: "fixed",
        right: "18px",
        bottom: "18px",
        zIndex: "9999",
        padding: "10px 16px",
        borderRadius: "10px",
        border: "1px solid #dadce0",
        background: "#ffffff",
        color: "#1a73e8",
        fontSize: "14px",
        fontWeight: "700",
        cursor: "pointer",
        boxShadow:
          "0 2px 8px rgba(0,0,0,.15)"
      }
    );

    connectButton.addEventListener(
      "click",
      connect
    );

    document.body.appendChild(
      connectButton
    );
  }

  window.GoogleDriveSync =
    Object.freeze({
      connect,
      ensureAppFolder,

      isConnected() {
        return Boolean(accessToken);
      }
    });

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      createTestButton
    );
  } else {
    createTestButton();
  }
})();
