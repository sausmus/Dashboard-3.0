(() => {
  "use strict";

  const CLIENT_ID =
    "427705878745-u2skb9n2egbgvdebag2kn1mgmf3mbpb0.apps.googleusercontent.com";

  const DRIVE_SCOPE =
    "https://www.googleapis.com/auth/drive.file";

  const APP_FOLDER_NAME = "Teacher Dashboard";
  const SHARED_FILE_NAME = "shared-data.json";
  const SHARED_SCHEMA_VERSION = 1;

  const SYNC_META_KEY =
    "teacherDashboard3.cloudSync.sharedDataMeta.v1";

  const SAVE_DEBOUNCE_MS = 750;

  const CLOUD_SHARED_EVENT_TYPES = new Set([
    "class-updated",
    "roster-updated",
    "bell-schedules-changed",
    "minimum-day-dates-changed",
    "new-school-year-reset",
    "new-school-year-reset-undone",
    "reset",
    "import",
    "external-storage-change"
  ]);

  let tokenClient = null;
  let accessToken = "";
  let connectButton = null;
  let appFolder = null;
  let sharedFile = null;
  let saveTimer = null;
  let isApplyingCloud = false;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function assertDashboardData() {
    if (!window.DashboardData) {
      throw new Error(
        "DashboardData is not loaded. Make sure shared/dashboard-data.js loads before google-drive-sync.js."
      );
    }
  }

  function setButtonState(text, disabled = false) {
    if (!connectButton) return;

    connectButton.textContent = text;
    connectButton.disabled = disabled;
    connectButton.style.cursor =
      disabled ? "default" : "pointer";
    connectButton.style.opacity =
      disabled ? "0.8" : "1";
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
            new Error(
              "Google Identity Services did not load."
            )
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

  async function driveFetch(
    url,
    options = {}
  ) {
    if (!accessToken) {
      throw new Error(
        "Google Drive is not connected."
      );
    }

    const headers =
      new Headers(options.headers || {});

    headers.set(
      "Authorization",
      `Bearer ${accessToken}`
    );

    const response = await fetch(
      url,
      {
        ...options,
        headers
      }
    );

    if (!response.ok) {
      let message =
        `Google Drive error ${response.status}`;

      try {
        const errorData =
          await response.json();

        message =
          errorData?.error?.message ||
          message;
      } catch (_) {}

      if (response.status === 401) {
        accessToken = "";

        setButtonState(
          "☁ Reconnect Drive"
        );
      }

      throw new Error(message);
    }

    return response;
  }

  async function driveJson(
    url,
    options = {}
  ) {
    const response =
      await driveFetch(
        url,
        options
      );

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async function driveText(
    url,
    options = {}
  ) {
    const response =
      await driveFetch(
        url,
        options
      );

    return response.text();
  }

  function escapeDriveQueryValue(
    value
  ) {
    return String(value)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");
  }

  async function findAppFolder() {
    const safeName =
      escapeDriveQueryValue(
        APP_FOLDER_NAME
      );

    const query = [
      `name = '${safeName}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false"
    ].join(" and ");

    const url =
      "https://www.googleapis.com/drive/v3/files" +
      `?q=${encodeURIComponent(query)}` +
      "&spaces=drive" +
      "&fields=files(id,name,mimeType,modifiedTime)" +
      "&pageSize=10";

    const result =
      await driveJson(url);

    return result.files?.[0] || null;
  }

  async function createAppFolder() {
    return driveJson(
      "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
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
    let folder =
      await findAppFolder();

    if (!folder) {
      folder =
        await createAppFolder();
    }

    return folder;
  }

  async function findSharedFile(
    folderId
  ) {
    const safeName =
      escapeDriveQueryValue(
        SHARED_FILE_NAME
      );

    const safeFolderId =
      escapeDriveQueryValue(
        folderId
      );

    const query = [
      `name = '${safeName}'`,
      `'${safeFolderId}' in parents`,
      "trashed = false"
    ].join(" and ");

    const url =
      "https://www.googleapis.com/drive/v3/files" +
      `?q=${encodeURIComponent(query)}` +
      "&spaces=drive" +
      "&fields=files(id,name,mimeType,modifiedTime,size)" +
      "&pageSize=10";

    const result =
      await driveJson(url);

    return result.files?.[0] || null;
  }

  function extractLocalSharedData() {
    assertDashboardData();

    const local =
      window.DashboardData.load();

    return {
      classes:
        clone(local.classes),

      calendar:
        clone(local.calendar),

      bellSchedules:
        clone(local.bellSchedules)
    };
  }

  function sharedSnapshot(
    sharedData
  ) {
    return JSON.stringify(
      sharedData
    );
  }

  function buildSharedPayload() {
    return {
      schemaVersion:
        SHARED_SCHEMA_VERSION,

      lastModified:
        new Date().toISOString(),

      data:
        extractLocalSharedData()
    };
  }

  function validateSharedPayload(
    payload
  ) {
    if (
      !payload ||
      typeof payload !== "object"
    ) {
      throw new Error(
        "shared-data.json does not contain valid JSON data."
      );
    }

    if (
      payload.schemaVersion !==
      SHARED_SCHEMA_VERSION
    ) {
      throw new Error(
        `Unsupported shared-data.json schema version: ${
          payload.schemaVersion ??
          "missing"
        }.`
      );
    }

    if (
      !payload.data ||
      typeof payload.data !== "object"
    ) {
      throw new Error(
        "shared-data.json is missing its data object."
      );
    }

    if (
      !payload.data.classes ||
      typeof payload.data.classes !==
        "object"
    ) {
      throw new Error(
        "shared-data.json is missing classes."
      );
    }

    return payload;
  }

  function getSyncMeta() {
    try {
      const raw =
        localStorage.getItem(
          SYNC_META_KEY
        );

      return raw
        ? JSON.parse(raw)
        : null;

    } catch (error) {
      console.warn(
        "Cloud sync metadata could not be read.",
        error
      );

      return null;
    }
  }

  function saveSyncMeta(
    file,
    sharedData
  ) {
    const meta = {
      version: 1,

      folderId:
        appFolder?.id || "",

      fileId:
        file?.id || "",

      lastDriveModifiedTime:
        file?.modifiedTime || "",

      lastSyncedSnapshot:
        sharedSnapshot(
          sharedData
        ),

      syncedAt:
        new Date().toISOString()
    };

    localStorage.setItem(
      SYNC_META_KEY,
      JSON.stringify(meta)
    );

    return meta;
  }

  async function createSharedFileMetadata(
    folderId
  ) {
    return driveJson(
      "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          name:
            SHARED_FILE_NAME,

          mimeType:
            "application/json",

          parents: [
            folderId
          ],

          appProperties: {
            teacherDashboardType:
              "shared-data",

            schemaVersion:
              String(
                SHARED_SCHEMA_VERSION
              )
          }
        })
      }
    );
  }

  async function uploadSharedPayload(
    fileId,
    payload
  ) {
    return driveJson(
      "https://www.googleapis.com/upload/drive/v3/files/" +
      encodeURIComponent(
        fileId
      ) +
      "?uploadType=media&fields=id,name,mimeType,modifiedTime,size",
      {
        method: "PATCH",

        headers: {
          "Content-Type":
            "application/json; charset=UTF-8"
        },

        body: JSON.stringify(
          payload,
          null,
          2
        )
      }
    );
  }

  async function createSharedFile(
    folderId,
    payload
  ) {
    const metadata =
      await createSharedFileMetadata(
        folderId
      );

    try {
      return await uploadSharedPayload(
        metadata.id,
        payload
      );

    } catch (error) {
      console.error(
        "shared-data.json metadata was created but its content upload failed.",
        error
      );

      throw error;
    }
  }

  async function downloadSharedPayload(
    fileId
  ) {
    const text =
      await driveText(
        "https://www.googleapis.com/drive/v3/files/" +
        encodeURIComponent(
          fileId
        ) +
        "?alt=media"
      );

    let parsed;

    try {
      parsed =
        JSON.parse(text);

    } catch (_) {
      throw new Error(
        "shared-data.json could not be parsed as JSON."
      );
    }

    return validateSharedPayload(
      parsed
    );
  }

  function applyCloudSharedData(
    payload
  ) {
    assertDashboardData();

    const local =
      window.DashboardData.load();

    const next = {
      ...local,

      classes:
        clone(
          payload.data.classes
        ),

      calendar:
        clone(
          payload.data.calendar ??
          local.calendar
        ),

      bellSchedules:
        clone(
          payload.data.bellSchedules ??
          local.bellSchedules
        )
    };

    isApplyingCloud = true;

    try {
      window.DashboardData.save(
        next,
        {
          type:
            "cloud-shared-data-applied"
        }
      );

    } finally {
      isApplyingCloud = false;
    }

    return extractLocalSharedData();
  }

  async function saveLocalSharedDataToDrive() {
    if (
      !accessToken ||
      !appFolder
    ) {
      return null;
    }

    setButtonState(
      "↻ Saving…",
      true
    );

    const payload =
      buildSharedPayload();

    if (!sharedFile) {
      sharedFile =
        await createSharedFile(
          appFolder.id,
          payload
        );

    } else {
      sharedFile =
        await uploadSharedPayload(
          sharedFile.id,
          payload
        );
    }

    saveSyncMeta(
      sharedFile,
      payload.data
    );

    setButtonState(
      "☁ Saved"
    );

    window.dispatchEvent(
      new CustomEvent(
        "teacher-dashboard-cloud-saved",
        {
          detail: {
            fileId:
              sharedFile.id,

            fileName:
              SHARED_FILE_NAME,

            modifiedTime:
              sharedFile.modifiedTime
          }
        }
      )
    );

    return clone(payload);
  }

  function scheduleCloudSave() {
    if (
      !accessToken ||
      !sharedFile ||
      isApplyingCloud
    ) {
      return;
    }

    if (saveTimer) {
      clearTimeout(
        saveTimer
      );
    }

    setButtonState(
      "↻ Saving…",
      true
    );

    saveTimer =
      setTimeout(
        async () => {
          saveTimer = null;

          try {
            await saveLocalSharedDataToDrive();

          } catch (error) {
            console.error(
              "Google Drive save failed.",
              error
            );

            setButtonState(
              "⚠ Sync Error"
            );
          }
        },

        SAVE_DEBOUNCE_MS
      );
  }

  async function reconcileSharedDataOnConnect() {
    appFolder =
      await ensureAppFolder();

    sharedFile =
      await findSharedFile(
        appFolder.id
      );

    // First-ever cloud setup:
    // create shared-data.json
    // using this device's data.
    if (!sharedFile) {
      const payload =
        buildSharedPayload();

      sharedFile =
        await createSharedFile(
          appFolder.id,
          payload
        );

      saveSyncMeta(
        sharedFile,
        payload.data
      );

      setButtonState(
        "☁ Saved"
      );

      return {
        action:
          "created-cloud-file",

        file:
          clone(sharedFile)
      };
    }

    const cloudPayload =
      await downloadSharedPayload(
        sharedFile.id
      );

    const localShared =
      extractLocalSharedData();

    const localSnapshot =
      sharedSnapshot(
        localShared
      );

    const cloudSnapshot =
      sharedSnapshot(
        cloudPayload.data
      );

    const meta =
      getSyncMeta();

    // Already identical.
    if (
      localSnapshot ===
      cloudSnapshot
    ) {
      saveSyncMeta(
        sharedFile,
        localShared
      );

      setButtonState(
        "☁ Saved"
      );

      return {
        action:
          "already-synced",

        file:
          clone(sharedFile)
      };
    }

    const sameTrackedFile =
      meta &&
      meta.fileId ===
        sharedFile.id;

    // First time this browser has
    // encountered an existing
    // cloud Dashboard.
    if (!sameTrackedFile) {
      const useCloud =
        window.confirm(
          "Teacher Dashboard found existing cloud data in Google Drive.\n\n" +
          "Press OK to use the Google Drive copy on this device.\n\n" +
          "Press Cancel to keep this device's current data and replace the cloud copy."
        );

      if (useCloud) {
        const applied =
          applyCloudSharedData(
            cloudPayload
          );

        saveSyncMeta(
          sharedFile,
          applied
        );

        setButtonState(
          "☁ Saved"
        );

        return {
          action:
            "downloaded-cloud-data",

          file:
            clone(sharedFile)
        };
      }

      await saveLocalSharedDataToDrive();

      return {
        action:
          "uploaded-local-data",

        file:
          clone(sharedFile)
      };
    }

    const localChanged =
      localSnapshot !==
      meta.lastSyncedSnapshot;

    const cloudChanged =
      Boolean(
        meta.lastDriveModifiedTime
      ) &&
      sharedFile.modifiedTime !==
        meta.lastDriveModifiedTime;

    if (
      localChanged &&
      !cloudChanged
    ) {
      await saveLocalSharedDataToDrive();

      return {
        action:
          "uploaded-local-data",

        file:
          clone(sharedFile)
      };
    }

    if (
      !localChanged &&
      cloudChanged
    ) {
      const applied =
        applyCloudSharedData(
          cloudPayload
        );

      saveSyncMeta(
        sharedFile,
        applied
      );

      setButtonState(
        "☁ Saved"
      );

      return {
        action:
          "downloaded-cloud-data",

        file:
          clone(sharedFile)
      };
    }

    if (
      !localChanged &&
      !cloudChanged
    ) {
      const applied =
        applyCloudSharedData(
          cloudPayload
        );

      saveSyncMeta(
        sharedFile,
        applied
      );

      setButtonState(
        "☁ Saved"
      );

      return {
        action:
          "normalized-from-cloud",

        file:
          clone(sharedFile)
      };
    }

    // Both local and Drive changed
    // since the previous sync.
    const useCloud =
      window.confirm(
        "Teacher Dashboard found changes on BOTH this device and Google Drive.\n\n" +
        "Press OK to use the Google Drive copy.\n\n" +
        "Press Cancel to keep this device's copy and replace the cloud copy."
      );

    if (useCloud) {
      const applied =
        applyCloudSharedData(
          cloudPayload
        );

      saveSyncMeta(
        sharedFile,
        applied
      );

      setButtonState(
        "☁ Saved"
      );

      return {
        action:
          "conflict-used-cloud",

        file:
          clone(sharedFile)
      };
    }

    await saveLocalSharedDataToDrive();

    return {
      action:
        "conflict-used-local",

      file:
        clone(sharedFile)
    };
  }

  async function finishConnection(
    tokenResponse
  ) {
    if (tokenResponse.error) {
      throw new Error(
        tokenResponse.error
      );
    }

    accessToken =
      tokenResponse.access_token;

    setButtonState(
      "☁ Syncing…",
      true
    );

    const result =
      await reconcileSharedDataOnConnect();

    console.log(
      "Teacher Dashboard Google Drive sync:",
      result
    );

    window.dispatchEvent(
      new CustomEvent(
        "teacher-dashboard-drive-connected",
        {
          detail: {
            folderId:
              appFolder.id,

            folderName:
              appFolder.name,

            sharedFileId:
              sharedFile?.id || "",

            syncAction:
              result.action
          }
        }
      )
    );

    return result;
  }

  async function connect() {
    try {
      assertDashboardData();

      setButtonState(
        "☁ Connecting…",
        true
      );

      await initialize();

      tokenClient.callback =
        async response => {
          try {
            await finishConnection(
              response
            );

          } catch (error) {
            console.error(
              "Google Drive connection failed.",
              error
            );

            setButtonState(
              "⚠ Drive Error"
            );

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

      setButtonState(
        "⚠ Drive Error"
      );

      alert(
        "Google Drive could not be connected:\n\n" +
        error.message
      );
    }
  }

  function createTestButton() {
    connectButton =
      document.createElement(
        "button"
      );

    connectButton.type =
      "button";

    connectButton.textContent =
      "☁ Connect Google Drive";

    Object.assign(
      connectButton.style,
      {
        position: "fixed",
        right: "18px",
        bottom: "18px",
        zIndex: "9999",

        padding:
          "10px 16px",

        borderRadius:
          "10px",

        border:
          "1px solid #dadce0",

        background:
          "#ffffff",

        color:
          "#1a73e8",

        fontSize:
          "14px",

        fontWeight:
          "700",

        cursor:
          "pointer",

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

  function installDashboardDataListener() {
    assertDashboardData();

    window.addEventListener(
      window.DashboardData.changeEvent,

      event => {
        if (
          isApplyingCloud
        ) {
          return;
        }

        const type =
          String(
            event?.detail?.type ??
            ""
          );

        if (
          !CLOUD_SHARED_EVENT_TYPES.has(
            type
          )
        ) {
          return;
        }

        scheduleCloudSave();
      }
    );
  }

  window.GoogleDriveSync =
    Object.freeze({
      connect,

      ensureAppFolder,

      reconcileSharedDataOnConnect,

      saveSharedDataNow:
        saveLocalSharedDataToDrive,

      isConnected() {
        return Boolean(
          accessToken
        );
      },

      getFolderId() {
        return (
          appFolder?.id ||
          ""
        );
      },

      getSharedFileId() {
        return (
          sharedFile?.id ||
          ""
        );
      }
    });

  function boot() {
    createTestButton();

    try {
      installDashboardDataListener();

    } catch (error) {
      console.error(
        "Teacher Dashboard cloud listener could not start.",
        error
      );
    }
  }

  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      boot
    );

  } else {
    boot();
  }
})();
