/* global window, document, URLSearchParams, gapi, google */
(function () {
  var statusEl = document.getElementById('status');
  var openBtn = document.getElementById('open-btn');
  var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  var token = params.get('access_token') || '';
  var appId = params.get('app_id') || '';
  var apiKey = params.get('api_key') || '';
  var callback = params.get('callback') || 'flashcards://picker-callback';
  // `mode=drive_files` (Link from Google Drive) also lists plain spreadsheet/package files.
  // Keep the list in sync with GOOGLE_DRIVE_PICKER_MIME_TYPES (platform-web).
  var driveFiles = params.get('mode') === 'drive_files';
  var mimeTypes = driveFiles
    ? [
        'application/vnd.google-apps.spreadsheet',
        'application/vnd.google-apps.document',
        'text/csv',
        'text/tab-separated-values',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/octet-stream',
        'application/zip',
        'application/x-zip-compressed',
      ]
    : ['application/vnd.google-apps.spreadsheet', 'application/vnd.google-apps.document'];
  var noun = driveFiles ? 'Sheets, Docs, or CSV/TSV/XLSX/.flashpkg files' : 'Sheets or Docs';
  document.getElementById('heading').textContent = 'Select Google ' + noun;

  if (!/^flashcards:\/\/picker-callback$/i.test(callback)) {
    statusEl.textContent = 'Invalid deep-link callback target.';
    return;
  }
  if (!token || !appId || !apiKey) {
    statusEl.textContent = 'Missing required Picker authorization parameters.';
    return;
  }

  function redirectWith(queryObj) {
    var q = new URLSearchParams(queryObj);
    window.location.href = callback + '?' + q.toString();
  }

  function launchPicker() {
    gapi.load('picker', function () {
      var docsView = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setIncludeFolders(driveFiles)
        .setMimeTypes(mimeTypes.join(','));

      var builder = new google.picker.PickerBuilder()
        .setAppId(appId)
        .setOrigin(window.location.origin)
        .setOAuthToken(token)
        .setDeveloperKey(apiKey)
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .addView(docsView)
        .setCallback(function (data) {
          if (data.action === google.picker.Action.PICKED) {
            var picked = (data.docs || []).map(function (d) {
              return { id: d.id, name: d.name, mimeType: d.mimeType, url: d.url };
            });
            statusEl.textContent = 'Returning selected files to Flashcards…';
            redirectWith({ files: JSON.stringify(picked) });
          } else if (data.action === google.picker.Action.CANCEL) {
            redirectWith({ files: '[]' });
          }
        });

      builder.build().setVisible(true);
      statusEl.textContent = 'Choose one or more ' + noun + ' to link.';
    });
  }

  openBtn.hidden = false;
  openBtn.addEventListener('click', launchPicker);
  launchPicker();
})();
