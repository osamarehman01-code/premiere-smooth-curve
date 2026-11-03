/* Minimal CEP bridge (instead of Adobe's full CSInterface.js) */
(function () {
  var adobe = window.__adobe_cep__;
  window.PSHost = {
    available: !!adobe,
    eval: function (script) {
      return new Promise(function (resolve) {
        if (!adobe) return resolve(null);
        adobe.evalScript(script, function (res) { resolve(res); });
      });
    },
    call: function (fn, arg) {
      var script = 'PS.' + fn + '(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')';
      return this.eval(script).then(function (res) {
        if (res === null) return { ok: false, error: 'Not running inside Premiere.' };
        if (res === 'EvalScript error.' || res === undefined) return { ok: false, error: 'Premiere script error.' };
        try { return JSON.parse(res); } catch (e) { return { ok: false, error: String(res) }; }
      });
    },
    // keep the panel from closing when the user clicks in Premiere: persistent extension
    makePersistent: function () {
      if (!adobe) return;
      try {
        var ev = { type: 'com.adobe.PhotoshopPersistent', scope: 'APPLICATION', appId: 'PPRO', extensionId: 'com.pronk.smooth.panel', data: '' };
        adobe.dispatchEvent(JSON.stringify(ev));
      } catch (e) { }
    },
    openDialog: function (title, filters) {
      if (!window.cep || !window.cep.fs) return null;
      var r = window.cep.fs.showOpenDialogEx(false, false, title, '', filters || ['json']);
      return r && r.data && r.data.length ? r.data[0] : null;
    },
    saveDialog: function (title, name) {
      if (!window.cep || !window.cep.fs) return null;
      var r = window.cep.fs.showSaveDialogEx(title, '', ['json'], name || 'preset.json');
      return r && r.data ? r.data : null;
    },
    readFile: function (p) {
      if (window.cep && window.cep.fs) { var r = window.cep.fs.readFile(p); return r.err === 0 ? r.data : null; }
      return null;
    },
    writeFile: function (p, s) {
      if (window.cep && window.cep.fs) { return window.cep.fs.writeFile(p, s).err === 0; }
      return false;
    }
  };
})();
