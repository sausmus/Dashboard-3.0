(() => {
  "use strict";

  /*
    Teacher Dashboard 3.0 — Google Drive Cloud Sync

    Cloud files:
      shared-data.json
      participation.json
      scoreboard.json
      agenda.json
      student-picker.json

    The Dashboard page is the cloud-sync host. When utilities are opened
    through the Dashboard shell, this page stays alive, so the Google access
    token stays in memory while the teacher moves between utilities.

    Important:
    - Google access tokens are NEVER written to localStorage.
    - Current class, bell session state, Participation undo, and other
      temporary UI state remain device-local.
  */

  const CLIENT_ID =
    "427705878745-u2skb9n2egbgvdebag2kn1mgmf3mbpb0.apps.googleusercontent.com";

  const DRIVE_SCOPE =
    "https://www.googleapis.com/auth/drive.file";

  const APP_FOLDER_NAME =
    "Teacher Dashboard";

  const META_KEY =
    "teacherDashboard3.cloudSync.meta.v2";

  const LEGACY_SHARED_META_KEY =
    "teacherDashboard3.cloudSync.sharedDataMeta.v1";

  const SCOREBOARD_KEY =
    "teacherDashboard3.scoreboard.v1";

  const STUDENT_PICKER_KEY =
    "teacherDashboard3.studentPicker.v1";

  const AGENDA_PREFIX =
    "teacherDashboard3.agenda.v1_";

  const SAVE_DEBOUNCE_MS = 900;
  const AGENDA_SAVE_DEBOUNCE_MS = 1400;
  const FOCUS_CHECK_THROTTLE_MS = 15000;

  const DOMAIN_ORDER = [
    "shared",
    "participation",
    "scoreboard",
    "agenda",
    "studentPicker"
  ];

  const DOMAIN_LABELS = {
    shared: "Dashboard settings and rosters",
    participation: "Participation",
    scoreboard: "Scoreboard",
    agenda: "Agenda",
    studentPicker: "Student Picker"
  };

  const DOMAIN_FILES = {
    shared: "shared-data.json",
    participation: "participation.json",
    scoreboard: "scoreboard.json",
    agenda: "agenda.json",
    studentPicker: "student-picker.json"
  };

  const DOMAIN_SCHEMA_VERSIONS = {
    shared: 1,
    participation: 1,
    scoreboard: 1,
    agenda: 1,
    studentPicker: 1
  };

  const SHARED_EVENT_TYPES = new Set([
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

  const PARTICIPATION_EVENT_TYPES = new Set([
    "participation-term-changed",
    "participation-goal-changed",
    "participation-points-changed",
    "new-school-year-reset",
    "new-school-year-reset-undone",
    "reset",
    "import",
    "external-storage-change"
  ]);

  let tokenClient = null;
  let accessToken = "";
  let tokenExpiryTimer = null;
  let connectButton = null;
  let appFolder = null;

  const domainFiles = new Map();
  const saveTimers = new Map();

  let isApplyingCloud = false;
  let isReconciling = false;
  let lastFocusCheckAt = 0;
  let saveQueue = Promise.resolve();

  function clone(value) {
    return JSON.parse(
      JSON.stringify(value)
    );
  }

  function assertDashboardData() {
    if (!window.DashboardData) {
      throw new Error(
        "DashboardData is not loaded. Make sure shared/dashboard-data.js loads before google-drive-sync.js."
      );
    }
  }

  function stableSnapshot(value) {
    return JSON.stringify(value);
  }

  function parseJsonOrNull(text) {
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch (error) {
      console.warn(
        "Teacher Dashboard found invalid local JSON.",
        error
      );
      return null;
    }
  }

  function defaultScoreboardState() {
    return {
      schemaVersion: 4,
      activeSeason: "Fall Semester Championship",
      seasons: {}
    };
  }

  function defaultPickerPeriod() {
    return {
      masterRoster: [],
      pool: [],
      history: [],
      groupConfig: {
        method: "size",
        value: 4
      },
      groups: []
    };
  }

  function defaultPickerState() {
    const periods = {};

    for (let i = 1; i <= 7; i += 1) {
      periods[String(i)] =
        defaultPickerPeriod();
    }

    return {
      currentPeriod: "1",
      visiblePeriods: [
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7"
      ],
      pickerConfig: {
        strategy: "random",
        target: "below-goal"
      },
      periods
    };
  }

  function readSharedDomain() {
    assertDashboardData();

    const local =
      DashboardData.load();

    return {
      classes:
        clone(local.classes),

      calendar:
        clone(local.calendar),

      bellSchedules:
        clone(local.bellSchedules)
    };
  }

  function applySharedDomain(data) {
    assertDashboardData();

    const local =
      DashboardData.load();

    DashboardData.save(
      {
        ...local,

        classes:
          clone(
            data?.classes ??
            local.classes
          ),

        calendar:
          clone(
            data?.calendar ??
            local.calendar
          ),

        bellSchedules:
          clone(
            data?.bellSchedules ??
            local.bellSchedules
          )
      },

      {
        type:
          "cloud-shared-data-applied"
      }
    );

    return readSharedDomain();
  }

  function readParticipationDomain() {
    assertDashboardData();

    return clone(
      DashboardData.load()
        .participation
    );
  }

  function applyParticipationDomain(data) {
    assertDashboardData();

    const local =
      DashboardData.load();

    DashboardData.save(
      {
        ...local,

        participation:
          clone(
            data ??
            local.participation
          )
      },

      {
        type:
          "cloud-participation-applied"
      }
    );

    return readParticipationDomain();
  }

  function readScoreboardDomain() {
    const parsed =
      parseJsonOrNull(
        localStorage.getItem(
          SCOREBOARD_KEY
        )
      );

    return clone(
      parsed ??
      defaultScoreboardState()
    );
  }

  function applyScoreboardDomain(data) {
    const next =
      data &&
      typeof data === "object"
        ? data
        : defaultScoreboardState();

    localStorage.setItem(
      SCOREBOARD_KEY,
      JSON.stringify(next)
    );

    return readScoreboardDomain();
  }

  function readAgendaDomain() {
    const days = {};
    const entries = [];

    for (
      let i = 0;
      i < localStorage.length;
      i += 1
    ) {

      const key =
        localStorage.key(i);

      if (
        !key ||
        !key.startsWith(
          AGENDA_PREFIX
        )
      ) {
        continue;
      }

      const dateKey =
        key.slice(
          AGENDA_PREFIX.length
        );

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(
          dateKey
        )
      ) {
        continue;
      }

      const parsed =
        parseJsonOrNull(
          localStorage.getItem(
            key
          )
        );

      if (parsed) {
        entries.push([
          dateKey,
          parsed
        ]);
      }
    }

    entries
      .sort(
        (a, b) =>
          a[0].localeCompare(b[0])
      )
      .forEach(
        ([dateKey, value]) => {
          days[dateKey] =
            value;
        }
      );

    return {
      days
    };
  }

  function removeAgendaStorage() {
    const keys = [];

    for (
      let i = 0;
      i < localStorage.length;
      i += 1
    ) {

      const key =
        localStorage.key(i);

      if (
        key &&
        key.startsWith(
          AGENDA_PREFIX
        )
      ) {
        keys.push(key);
      }
    }

    keys.forEach(
      key =>
        localStorage.removeItem(
          key
        )
    );
  }

  function applyAgendaDomain(data) {
    removeAgendaStorage();

    const days =
      data?.days &&
      typeof data.days === "object"
        ? data.days
        : {};

    Object.entries(days)
      .sort(
        (a, b) =>
          a[0].localeCompare(b[0])
      )
      .forEach(
        ([dateKey, value]) => {

          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(
              dateKey
            )
          ) {
            return;
          }

          localStorage.setItem(
            AGENDA_PREFIX +
              dateKey,

            JSON.stringify(
              value
            )
          );
        }
      );

    return readAgendaDomain();
  }

  function readPickerRawState() {
    const parsed =
      parseJsonOrNull(
        localStorage.getItem(
          STUDENT_PICKER_KEY
        )
      );

    return clone(
      parsed ??
      defaultPickerState()
    );
  }

  /*
    Picker cloud data intentionally excludes currentPeriod and
    visiblePeriods. Those are driven by the shared Dashboard.

    masterRoster remains inside each period only as a derivative snapshot
    used by Student Picker to detect roster changes. It is never authoritative
    and Student Picker never writes it back to DashboardData.
  */

  function readStudentPickerDomain() {
    const state =
      readPickerRawState();

    return {
      pickerConfig:
        clone(
          state.pickerConfig ??
          {
            strategy: "random",
            target: "below-goal"
          }
        ),

      periods:
        clone(
          state.periods ??
          defaultPickerState().periods
        )
    };
  }

  function applyStudentPickerDomain(data) {
    const current =
      readPickerRawState();

    const next = {
      ...current,

      pickerConfig:
        clone(
          data?.pickerConfig ??
          current.pickerConfig
        ),

      periods:
        clone(
          data?.periods ??
          current.periods
        )
    };

    localStorage.setItem(
      STUDENT_PICKER_KEY,
      JSON.stringify(next)
    );

    return readStudentPickerDomain();
  }

  const DOMAIN_HANDLERS = {
    shared: {
      read:
        readSharedDomain,

      apply:
        applySharedDomain
    },

    participation: {
      read:
        readParticipationDomain,

      apply:
        applyParticipationDomain
    },

    scoreboard: {
      read:
        readScoreboardDomain,

      apply:
        applyScoreboardDomain
    },

    agenda: {
      read:
        readAgendaDomain,

      apply:
        applyAgendaDomain
    },

    studentPicker: {
      read:
        readStudentPickerDomain,

      apply:
        applyStudentPickerDomain
    }
  };

  function readDomainData(
    domainKey
  ) {

    const handler =
      DOMAIN_HANDLERS[
        domainKey
      ];

    if (!handler) {
      throw new Error(
        `Unknown cloud domain: ${domainKey}`
      );
    }

    return clone(
      handler.read()
    );
  }

  function applyDomainData(
    domainKey,
    data
  ) {

    const handler =
      DOMAIN_HANDLERS[
        domainKey
      ];

    if (!handler) {
      throw new Error(
        `Unknown cloud domain: ${domainKey}`
      );
    }

    isApplyingCloud =
      true;

    try {

      return clone(
        handler.apply(
          clone(data)
        )
      );

    } finally {

      isApplyingCloud =
        false;
    }
  }

  function buildPayload(
    domainKey
  ) {

    return {
      schemaVersion:
        DOMAIN_SCHEMA_VERSIONS[
          domainKey
        ],

      domain:
        domainKey,

      lastModified:
        new Date()
          .toISOString(),

      data:
        readDomainData(
          domainKey
        )
    };
  }

  function validatePayload(
    domainKey,
    payload
  ) {

    if (
      !payload ||
      typeof payload !== "object"
    ) {

      throw new Error(
        `${DOMAIN_FILES[domainKey]} does not contain valid JSON data.`
      );
    }

    if (
      payload.schemaVersion !==
      DOMAIN_SCHEMA_VERSIONS[
        domainKey
      ]
    ) {

      throw new Error(
        `Unsupported ${DOMAIN_FILES[domainKey]} schema version: ${
          payload.schemaVersion ??
          "missing"
        }.`
      );
    }

    /*
      shared-data.json from Cloud Sync 3.0A did not include a domain
      property, so missing domain is accepted for backward compatibility.
    */

    if (
      payload.domain &&
      payload.domain !==
        domainKey
    ) {

      throw new Error(
        `${DOMAIN_FILES[domainKey]} contains the wrong cloud data type.`
      );
    }

    if (
      !Object.prototype
        .hasOwnProperty.call(
          payload,
          "data"
        )
    ) {

      throw new Error(
        `${DOMAIN_FILES[domainKey]} is missing its data object.`
      );
    }

    return payload;
  }

  function createEmptyMeta() {

    return {
      version: 2,
      folderId: "",
      domains: {}
    };
  }

  function migrateLegacySharedMeta(
    meta
  ) {

    if (
      meta.domains?.shared
    ) {
      return meta;
    }

    try {

      const raw =
        localStorage.getItem(
          LEGACY_SHARED_META_KEY
        );

      if (!raw) {
        return meta;
      }

      const legacy =
        JSON.parse(raw);

      if (
        !legacy ||
        typeof legacy !==
          "object"
      ) {
        return meta;
      }

      meta.folderId =
        meta.folderId ||
        legacy.folderId ||
        "";

      meta.domains.shared = {
        fileId:
          legacy.fileId || "",

        lastDriveModifiedTime:
          legacy.lastDriveModifiedTime ||
          "",

        lastSyncedSnapshot:
          legacy.lastSyncedSnapshot ||
          "",

        syncedAt:
          legacy.syncedAt || ""
      };

      return meta;

    } catch (error) {

      console.warn(
        "Legacy cloud sync metadata could not be migrated.",
        error
      );

      return meta;
    }
  }

  function getSyncMeta() {

    let meta =
      createEmptyMeta();

    try {

      const raw =
        localStorage.getItem(
          META_KEY
        );

      if (raw) {

        const parsed =
          JSON.parse(raw);

        if (
          parsed &&
          typeof parsed ===
            "object"
        ) {

          meta = {
            version: 2,

            folderId:
              String(
                parsed.folderId ||
                ""
              ),

            domains:
              parsed.domains &&
              typeof parsed.domains ===
                "object"
                ? parsed.domains
                : {}
          };
        }
      }

    } catch (error) {

      console.warn(
        "Cloud sync metadata could not be read.",
        error
      );
    }

    return migrateLegacySharedMeta(
      meta
    );
  }

  function saveSyncMeta(
    meta
  ) {

    const normalized = {
      version: 2,

      folderId:
        String(
          meta?.folderId ||
          appFolder?.id ||
          ""
        ),

      domains:
        meta?.domains &&
        typeof meta.domains ===
          "object"
          ? meta.domains
          : {}
    };

    localStorage.setItem(
      META_KEY,

      JSON.stringify(
        normalized
      )
    );

    return normalized;
  }

  function getDomainMeta(
    domainKey
  ) {

    return (
      getSyncMeta()
        .domains?.[
          domainKey
        ] ??
      null
    );
  }

  function saveDomainMeta(
    domainKey,
    file,
    data
  ) {

    const meta =
      getSyncMeta();

    meta.folderId =
      appFolder?.id ||
      meta.folderId ||
      "";

    meta.domains[
      domainKey
    ] = {

      fileId:
        file?.id || "",

      lastDriveModifiedTime:
        file?.modifiedTime ||
        "",

      lastSyncedSnapshot:
        stableSnapshot(
          data
        ),

      syncedAt:
        new Date()
          .toISOString()
    };

    saveSyncMeta(meta);

    return meta.domains[
      domainKey
    ];
  }

  function setButtonState(
    text,
    disabled = false
  ) {

    if (!connectButton) {
      return;
    }

    connectButton.textContent =
      text;

    connectButton.disabled =
      disabled;

    connectButton.style.cursor =
      disabled
        ? "default"
        : "pointer";

    connectButton.style.opacity =
      disabled
        ? "0.82"
        : "1";
  }

  function setButtonTitle(
    title
  ) {

    if (connectButton) {
      connectButton.title =
        title;
    }
  }

  function waitForGoogleIdentity() {

    return new Promise(
      (resolve, reject) => {

        const started =
          Date.now();

        const timer =
          setInterval(
            () => {

              if (
                window.google &&
                google.accounts &&
                google.accounts
                  .oauth2
              ) {

                clearInterval(
                  timer
                );

                resolve();

                return;
              }

              if (
                Date.now() -
                  started >
                10000
              ) {

                clearInterval(
                  timer
                );

                reject(
                  new Error(
                    "Google Identity Services did not load."
                  )
                );
              }

            },

            100
          );
      }
    );
  }

  async function initialize() {

    if (tokenClient) {
      return;
    }

    await waitForGoogleIdentity();

    tokenClient =
      google.accounts.oauth2
        .initTokenClient({

          client_id:
            CLIENT_ID,

          scope:
            DRIVE_SCOPE,

          callback:
            () => {},

          error_callback:
            error => {

              console.warn(
                "Google OAuth popup error:",
                error
              );

              if (
                !accessToken
              ) {

                setButtonState(
                  "☁ Connect Drive"
                );
              }
            }
        });
  }

  function clearToken() {

    accessToken = "";

    if (tokenExpiryTimer) {

      clearTimeout(
        tokenExpiryTimer
      );

      tokenExpiryTimer =
        null;
    }

    setButtonState(
      "☁ Reconnect Drive"
    );

    setButtonTitle(
      "Google access expired. Click to reconnect."
    );
  }

  function rememberToken(
    tokenResponse
  ) {

    accessToken =
      tokenResponse
        .access_token ||
      "";

    if (tokenExpiryTimer) {

      clearTimeout(
        tokenExpiryTimer
      );
    }

    const seconds =
      Math.max(
        60,
        Number(
          tokenResponse
            .expires_in
        ) || 3600
      );

    /*
      Expire our in-memory copy a little early. Google Identity Services'
      browser token model requires a new user-driven token request after
      an access token expires, so the button simply becomes Reconnect.
    */

    tokenExpiryTimer =
      setTimeout(
        clearToken,

        Math.max(
          30000,
          seconds * 1000 -
            30000
        )
      );
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
      new Headers(
        options.headers ||
        {}
      );

    headers.set(
      "Authorization",
      `Bearer ${accessToken}`
    );

    const response =
      await fetch(
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
          errorData?.error
            ?.message ||
          message;

      } catch (_) {}

      if (
        response.status ===
        401
      ) {

        clearToken();
      }

      throw new Error(
        message
      );
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

    if (
      response.status ===
      204
    ) {
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
      .replace(
        /\\/g,
        "\\\\"
      )
      .replace(
        /'/g,
        "\\'"
      );
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

    return (
      result.files?.[0] ||
      null
    );
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

        body:
          JSON.stringify({
            name:
              APP_FOLDER_NAME,

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

    appFolder = folder;

    const meta =
      getSyncMeta();

    meta.folderId =
      folder.id;

    saveSyncMeta(meta);

    return folder;
  }

  async function findDomainFile(
    folderId,
    domainKey
  ) {

    const fileName =
      DOMAIN_FILES[
        domainKey
      ];

    const safeName =
      escapeDriveQueryValue(
        fileName
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

    return (
      result.files?.[0] ||
      null
    );
  }

  async function getFileMetadata(
    fileId
  ) {

    return driveJson(
      "https://www.googleapis.com/drive/v3/files/" +
        encodeURIComponent(
          fileId
        ) +
        "?fields=id,name,mimeType,modifiedTime,size"
    );
  }

  async function createDomainFileMetadata(
    folderId,
    domainKey
  ) {

    return driveJson(
      "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,modifiedTime",

      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({

            name:
              DOMAIN_FILES[
                domainKey
              ],

            mimeType:
              "application/json",

            parents: [
              folderId
            ],

            appProperties: {
              teacherDashboardType:
                domainKey,

              schemaVersion:
                String(
                  DOMAIN_SCHEMA_VERSIONS[
                    domainKey
                  ]
                )
            }
          })
      }
    );
  }

  async function uploadDomainPayload(
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

        body:
          JSON.stringify(
            payload,
            null,
            2
          )
      }
    );
  }

  async function createDomainFile(
    folderId,
    domainKey,
    payload
  ) {

    const metadata =
      await createDomainFileMetadata(
        folderId,
        domainKey
      );

    return uploadDomainPayload(
      metadata.id,
      payload
    );
  }

  async function downloadDomainPayload(
    domainKey,
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
        `${DOMAIN_FILES[domainKey]} could not be parsed as JSON.`
      );
    }

    return validatePayload(
      domainKey,
      parsed
    );
  }

  async function ensureDomainFile(
    domainKey
  ) {

    let file =
      domainFiles.get(
        domainKey
      );

    if (file) {
      return file;
    }

    if (!appFolder) {

      await ensureAppFolder();
    }

    file =
      await findDomainFile(
        appFolder.id,
        domainKey
      );

    if (!file) {

      const payload =
        buildPayload(
          domainKey
        );

      file =
        await createDomainFile(
          appFolder.id,
          domainKey,
          payload
        );

      saveDomainMeta(
        domainKey,
        file,
        payload.data
      );
    }

    domainFiles.set(
      domainKey,
      file
    );

    return file;
  }

  function refreshActiveUtility() {

    try {

      window
        .TeacherDashboardShell
        ?.refreshActiveUtility?.();

    } catch (_) {}
  }

  async function saveDomainToDrive(
    domainKey,
    options = {}
  ) {

    if (
      !accessToken ||
      isApplyingCloud ||
      isReconciling
    ) {
      return null;
    }

    const data =
      readDomainData(
        domainKey
      );

    const snapshot =
      stableSnapshot(
        data
      );

    const meta =
      getDomainMeta(
        domainKey
      );

    if (
      !options.force &&
      meta &&
      meta.lastSyncedSnapshot ===
        snapshot
    ) {

      return {
        action:
          "unchanged",

        domain:
          domainKey
      };
    }

    const file =
      await ensureDomainFile(
        domainKey
      );

    const payload = {

      schemaVersion:
        DOMAIN_SCHEMA_VERSIONS[
          domainKey
        ],

      domain:
        domainKey,

      lastModified:
        new Date()
          .toISOString(),

      data
    };

    const updatedFile =
      await uploadDomainPayload(
        file.id,
        payload
      );

    domainFiles.set(
      domainKey,
      updatedFile
    );

    saveDomainMeta(
      domainKey,
      updatedFile,
      data
    );

    window.dispatchEvent(
      new CustomEvent(
        "teacher-dashboard-cloud-saved",

        {
          detail: {
            domain:
              domainKey,

            fileId:
              updatedFile.id,

            fileName:
              DOMAIN_FILES[
                domainKey
              ],

            modifiedTime:
              updatedFile
                .modifiedTime
          }
        }
      )
    );

    return {
      action:
        "uploaded",

      domain:
        domainKey,

      file:
        clone(
          updatedFile
        )
    };
  }

  function runQueuedSave(
    domainKey
  ) {

    saveQueue =
      saveQueue
        .then(
          async () => {

            if (!accessToken) {
              return null;
            }

            setButtonState(
              "↻ Saving…",
              true
            );

            const result =
              await saveDomainToDrive(
                domainKey
              );

            if (accessToken) {

              setButtonState(
                "☁ Synced"
              );

              setButtonTitle(
                "Google Drive connected. Click to sync now."
              );
            }

            return result;
          }
        )

        .catch(
          error => {

            console.error(
              `Google Drive save failed for ${DOMAIN_LABELS[domainKey]}.`,
              error
            );

            if (accessToken) {

              setButtonState(
                "⚠ Sync Error"
              );

              setButtonTitle(
                error.message
              );
            }
          }
        );

    return saveQueue;
  }

  function scheduleDomainSave(
    domainKey
  ) {

    if (
      !accessToken ||
      isApplyingCloud ||
      isReconciling
    ) {
      return;
    }

    const existing =
      saveTimers.get(
        domainKey
      );

    if (existing) {

      clearTimeout(existing);
    }

    const delay =
      domainKey === "agenda"
        ? AGENDA_SAVE_DEBOUNCE_MS
        : SAVE_DEBOUNCE_MS;

    const timer =
      setTimeout(
        () => {

          saveTimers.delete(
            domainKey
          );

          runQueuedSave(
            domainKey
          );

        },

        delay
      );

    saveTimers.set(
      domainKey,
      timer
    );
  }

  function cancelPendingSaves() {

    saveTimers.forEach(
      timer =>
        clearTimeout(timer)
    );

    saveTimers.clear();
  }

  async function createMissingCloudDomain(
    domainKey
  ) {

    const payload =
      buildPayload(
        domainKey
      );

    const file =
      await createDomainFile(
        appFolder.id,
        domainKey,
        payload
      );

    domainFiles.set(
      domainKey,
      file
    );

    saveDomainMeta(
      domainKey,
      file,
      payload.data
    );

    return {
      action:
        "created-cloud-file",

      domain:
        domainKey,

      file:
        clone(file)
    };
  }

  async function uploadLocalDomain(
    domainKey,
    file
  ) {

    const payload =
      buildPayload(
        domainKey
      );

    const updatedFile =
      await uploadDomainPayload(
        file.id,
        payload
      );

    domainFiles.set(
      domainKey,
      updatedFile
    );

    saveDomainMeta(
      domainKey,
      updatedFile,
      payload.data
    );

    return {
      action:
        "uploaded-local-data",

      domain:
        domainKey,

      file:
        clone(updatedFile)
    };
  }

  function applyCloudPayload(
    domainKey,
    file,
    cloudPayload,
    action
  ) {

    const applied =
      applyDomainData(
        domainKey,
        cloudPayload.data
      );

    saveDomainMeta(
      domainKey,
      file,
      applied
    );

    return {
      action,

      domain:
        domainKey,

      file:
        clone(file)
    };
  }

  async function loadCloudStateForDomains() {

    const states = {};

    await Promise.all(
      DOMAIN_ORDER.map(
        async domainKey => {

          const file =
            await findDomainFile(
              appFolder.id,
              domainKey
            );

          if (!file) {

            states[
              domainKey
            ] = {
              file: null,
              payload: null
            };

            return;
          }

          domainFiles.set(
            domainKey,
            file
          );

          const payload =
            await downloadDomainPayload(
              domainKey,
              file.id
            );

          states[
            domainKey
          ] = {
            file,
            payload
          };
        }
      )
    );

    return states;
  }

  async function reconcileAllOnConnect() {

    assertDashboardData();

    cancelPendingSaves();

    isReconciling =
      true;

    setButtonState(
      "☁ Syncing…",
      true
    );

    let appliedCloud =
      false;

    try {

      appFolder =
        await ensureAppFolder();

      const cloudStates =
        await loadCloudStateForDomains();

      const untrackedDifferences =
        [];

      for (
        const domainKey of
        DOMAIN_ORDER
      ) {

        const state =
          cloudStates[
            domainKey
          ];

        if (
          !state?.file ||
          !state?.payload
        ) {
          continue;
        }

        const localData =
          readDomainData(
            domainKey
          );

        const localSnapshot =
          stableSnapshot(
            localData
          );

        const cloudSnapshot =
          stableSnapshot(
            state.payload.data
          );

        const meta =
          getDomainMeta(
            domainKey
          );

        const sameTrackedFile =
          Boolean(
            meta &&
            meta.fileId ===
              state.file.id
          );

        if (
          !sameTrackedFile &&
          localSnapshot !==
            cloudSnapshot
        ) {

          untrackedDifferences.push(
            domainKey
          );
        }
      }

      let useCloudForUntracked =
        null;

      if (
        untrackedDifferences
          .length > 0
      ) {

        const labels =
          untrackedDifferences
            .map(
              key =>
                `• ${DOMAIN_LABELS[key]}`
            )
            .join("\n");

        useCloudForUntracked =
          window.confirm(
            "Teacher Dashboard found existing cloud data in Google Drive that this browser has not synced before:\n\n" +
            labels +
            "\n\nPress OK to use the Google Drive copies on this device.\n\n" +
            "Press Cancel to keep this browser's local copies and replace those cloud copies."
          );
      }

      const results = [];

      for (
        const domainKey of
        DOMAIN_ORDER
      ) {

        const cloudState =
          cloudStates[
            domainKey
          ];

        if (
          !cloudState?.file
        ) {

          results.push(
            await createMissingCloudDomain(
              domainKey
            )
          );

          continue;
        }

        const file =
          cloudState.file;

        const cloudPayload =
          cloudState.payload;

        const localData =
          readDomainData(
            domainKey
          );

        const localSnapshot =
          stableSnapshot(
            localData
          );

        const cloudSnapshot =
          stableSnapshot(
            cloudPayload.data
          );

        const meta =
          getDomainMeta(
            domainKey
          );

        const sameTrackedFile =
          Boolean(
            meta &&
            meta.fileId ===
              file.id
          );

        if (
          localSnapshot ===
          cloudSnapshot
        ) {

          saveDomainMeta(
            domainKey,
            file,
            localData
          );

          results.push({
            action:
              "already-synced",

            domain:
              domainKey,

            file:
              clone(file)
          });

          continue;
        }

        if (!sameTrackedFile) {

          if (
            useCloudForUntracked
          ) {

            results.push(
              applyCloudPayload(
                domainKey,
                file,
                cloudPayload,
                "downloaded-cloud-data"
              )
            );

            appliedCloud =
              true;

          } else {

            results.push(
              await uploadLocalDomain(
                domainKey,
                file
              )
            );
          }

          continue;
        }

        const localChanged =
          localSnapshot !==
          meta.lastSyncedSnapshot;

        const cloudChanged =
          file.modifiedTime !==
          meta.lastDriveModifiedTime;

        if (
          localChanged &&
          !cloudChanged
        ) {

          results.push(
            await uploadLocalDomain(
              domainKey,
              file
            )
          );

          continue;
        }

        if (
          !localChanged &&
          cloudChanged
        ) {

          results.push(
            applyCloudPayload(
              domainKey,
              file,
              cloudPayload,
              "downloaded-cloud-data"
            )
          );

          appliedCloud =
            true;

          continue;
        }

        if (
          !localChanged &&
          !cloudChanged
        ) {

          results.push(
            applyCloudPayload(
              domainKey,
              file,
              cloudPayload,
              "normalized-from-cloud"
            )
          );

          appliedCloud =
            true;

          continue;
        }

        const useCloud =
          window.confirm(
            `Teacher Dashboard found changes to ${DOMAIN_LABELS[domainKey]} on BOTH this device and Google Drive.\n\n` +
            "Press OK to use the Google Drive copy.\n\n" +
            "Press Cancel to keep this device's copy and replace the cloud copy."
          );

        if (useCloud) {

          results.push(
            applyCloudPayload(
              domainKey,
              file,
              cloudPayload,
              "conflict-used-cloud"
            )
          );

          appliedCloud =
            true;

        } else {

          results.push(
            await uploadLocalDomain(
              domainKey,
              file
            )
          );
        }
      }

      if (appliedCloud) {

        refreshActiveUtility();
      }

      setButtonState(
        "☁ Synced"
      );

      setButtonTitle(
        "Google Drive connected. Click to sync now."
      );

      return results;

    } finally {

      isReconciling =
        false;
    }
  }

  async function checkRemoteChanges() {

    if (
      !accessToken ||
      isReconciling ||
      isApplyingCloud
    ) {
      return [];
    }

    const changed = [];
    let appliedCloud =
      false;

    for (
      const domainKey of
      DOMAIN_ORDER
    ) {

      const meta =
        getDomainMeta(
          domainKey
        );

      if (
        !meta?.fileId
      ) {
        continue;
      }

      let file;

      try {

        file =
          await getFileMetadata(
            meta.fileId
          );

      } catch (error) {

        console.warn(
          `Could not check ${DOMAIN_FILES[domainKey]} for remote changes.`,
          error
        );

        continue;
      }

      domainFiles.set(
        domainKey,
        file
      );

      if (
        file.modifiedTime ===
        meta.lastDriveModifiedTime
      ) {
        continue;
      }

      const cloudPayload =
        await downloadDomainPayload(
          domainKey,
          file.id
        );

      const localData =
        readDomainData(
          domainKey
        );

      const localSnapshot =
        stableSnapshot(
          localData
        );

      const cloudSnapshot =
        stableSnapshot(
          cloudPayload.data
        );

      if (
        localSnapshot ===
        cloudSnapshot
      ) {

        saveDomainMeta(
          domainKey,
          file,
          localData
        );

        continue;
      }

      const localChanged =
        localSnapshot !==
        meta.lastSyncedSnapshot;

      if (!localChanged) {

        changed.push(
          applyCloudPayload(
            domainKey,
            file,
            cloudPayload,
            "remote-update-applied"
          )
        );

        appliedCloud =
          true;

        continue;
      }

      const useCloud =
        window.confirm(
          `${DOMAIN_LABELS[domainKey]} changed in Google Drive while this device also has unsynced changes.\n\n` +
          "Press OK to use the Google Drive copy.\n\n" +
          "Press Cancel to keep this device's copy and replace the cloud copy."
        );

      if (useCloud) {

        changed.push(
          applyCloudPayload(
            domainKey,
            file,
            cloudPayload,
            "remote-conflict-used-cloud"
          )
        );

        appliedCloud =
          true;

      } else {

        changed.push(
          await uploadLocalDomain(
            domainKey,
            file
          )
        );
      }
    }

    if (appliedCloud) {

      refreshActiveUtility();
    }

    if (
      accessToken
    ) {

      setButtonState(
        "☁ Synced"
      );

      setButtonTitle(
        "Google Drive connected. Click to sync now."
      );
    }

    return changed;
  }

  async function syncNow() {

    if (!accessToken) {
      return connect();
    }

    try {

      setButtonState(
        "☁ Syncing…",
        true
      );

      const remote =
        await checkRemoteChanges();

      for (
        const domainKey of
        DOMAIN_ORDER
      ) {

        await saveDomainToDrive(
          domainKey
        );
      }

      setButtonState(
        "☁ Synced"
      );

      setButtonTitle(
        "Google Drive connected. Click to sync now."
      );

      return remote;

    } catch (error) {

      console.error(
        "Google Drive manual sync failed.",
        error
      );

      if (accessToken) {

        setButtonState(
          "⚠ Sync Error"
        );

        setButtonTitle(
          error.message
        );
      }

      return null;
    }
  }

  async function finishConnection(
    tokenResponse
  ) {

    if (
      tokenResponse?.error
    ) {

      throw new Error(
        tokenResponse
          .error_description ||
        tokenResponse.error
      );
    }

    if (
      !tokenResponse
        ?.access_token
    ) {

      throw new Error(
        "Google did not return an access token."
      );
    }

    rememberToken(
      tokenResponse
    );

    const results =
      await reconcileAllOnConnect();

    console.log(
      "Teacher Dashboard Google Drive sync:",
      results
    );

    const files = {};

    DOMAIN_ORDER.forEach(
      domainKey => {

        const file =
          domainFiles.get(
            domainKey
          );

        if (file) {

          files[
            domainKey
          ] = {

            id:
              file.id,

            name:
              file.name ||
              DOMAIN_FILES[
                domainKey
              ]
          };
        }
      }
    );

    window.dispatchEvent(
      new CustomEvent(
        "teacher-dashboard-drive-connected",

        {
          detail: {

            folderId:
              appFolder?.id ||
              "",

            folderName:
              appFolder?.name ||
              APP_FOLDER_NAME,

            files,

            results:
              clone(results)
          }
        }
      )
    );

    return results;
  }

  async function connect() {

    if (accessToken) {
      return syncNow();
    }

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

            if (accessToken) {

              setButtonState(
                "⚠ Drive Error"
              );

            } else {

              setButtonState(
                "☁ Connect Drive"
              );
            }

            setButtonTitle(
              error.message
            );

            alert(
              "Google Drive could not be connected:\n\n" +
              error.message
            );
          }
        };

      /*
        Empty prompt avoids forcing the consent screen every time.
        Google will still ask for consent the first time permission is needed.
        A user click is still required by Google's browser token model.
      */

      tokenClient.requestAccessToken({
        prompt: ""
      });

    } catch (error) {

      console.error(
        "Google Drive connection failed.",
        error
      );

      setButtonState(
        "☁ Connect Drive"
      );

      setButtonTitle(
        error.message
      );

      alert(
        "Google Drive could not be connected:\n\n" +
        error.message
      );
    }

    return null;
  }

  function createConnectButton() {

    connectButton =
      document.createElement(
        "button"
      );

    connectButton.type =
      "button";

    connectButton.textContent =
      "☁ Connect Drive";

    connectButton.title =
      "Connect Teacher Dashboard to Google Drive.";

    Object.assign(
      connectButton.style,

      {
        position:
          "fixed",

        right:
          "18px",

        bottom:
          "18px",

        zIndex:
          "100000",

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

    connectButton
      .addEventListener(
        "click",
        connect
      );

    document.body
      .appendChild(
        connectButton
      );
  }

  function installDashboardDataListener() {

    assertDashboardData();

    window.addEventListener(
      DashboardData.changeEvent,

      event => {

        if (
          isApplyingCloud ||
          isReconciling
        ) {
          return;
        }

        const type =
          String(
            event?.detail
              ?.type ||
            ""
          );

        if (
          SHARED_EVENT_TYPES.has(
            type
          )
        ) {

          scheduleDomainSave(
            "shared"
          );
        }

        if (
          PARTICIPATION_EVENT_TYPES.has(
            type
          )
        ) {

          scheduleDomainSave(
            "participation"
          );
        }
      }
    );
  }

  function installStorageListener() {

    window.addEventListener(
      "storage",

      event => {

        if (
          isApplyingCloud ||
          isReconciling ||
          !event.key
        ) {
          return;
        }

        if (
          event.key ===
          DashboardData.storageKey
        ) {

          /*
            An iframe utility changed DashboardData.
            We schedule both domains; the snapshot guard prevents
            unnecessary uploads if only one actually changed.
          */

          scheduleDomainSave(
            "shared"
          );

          scheduleDomainSave(
            "participation"
          );

          return;
        }

        if (
          event.key ===
          SCOREBOARD_KEY
        ) {

          scheduleDomainSave(
            "scoreboard"
          );

          return;
        }

        if (
          event.key ===
          STUDENT_PICKER_KEY
        ) {

          scheduleDomainSave(
            "studentPicker"
          );

          return;
        }

        if (
          event.key.startsWith(
            AGENDA_PREFIX
          )
        ) {

          scheduleDomainSave(
            "agenda"
          );
        }
      }
    );
  }

  function installFocusListener() {

    window.addEventListener(
      "focus",

      () => {

        if (!accessToken) {
          return;
        }

        const now =
          Date.now();

        if (
          now -
            lastFocusCheckAt <
          FOCUS_CHECK_THROTTLE_MS
        ) {
          return;
        }

        lastFocusCheckAt =
          now;

        checkRemoteChanges()
          .catch(
            error => {

              console.warn(
                "Cloud refresh on window focus failed.",
                error
              );
            }
          );
      }
    );
  }

  window.GoogleDriveSync =
    Object.freeze({

      connect,

      syncNow,

      checkRemoteChanges,

      ensureAppFolder,

      saveAllNow:
        async () => {

          for (
            const domainKey of
            DOMAIN_ORDER
          ) {

            await saveDomainToDrive(
              domainKey,
              {
                force: true
              }
            );
          }
        },

      saveDomainNow:
        domainKey =>
          saveDomainToDrive(
            domainKey,
            {
              force: true
            }
          ),

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

      getCloudFiles() {

        const result = {};

        DOMAIN_ORDER.forEach(
          domainKey => {

            const file =
              domainFiles.get(
                domainKey
              );

            if (file) {

              result[
                domainKey
              ] =
                clone(file);
            }
          }
        );

        return result;
      }
    });

  function boot() {

    createConnectButton();

    try {

      installDashboardDataListener();

      installStorageListener();

      installFocusListener();

    } catch (error) {

      console.error(
        "Teacher Dashboard cloud listeners could not start.",
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
