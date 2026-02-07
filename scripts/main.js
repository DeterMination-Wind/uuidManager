// UUID Manager - Mindustry client-side helper mod.
//
// Features:
// - Edit your UUID under the player name in the Join Game dialog.
// - Save multiple UUIDs with notes and quick-switch.
// - Auto-calculate UID (server-side UUID) from UUID.
// - Configure per-server UUID auto switch (exact ip:port match).

const Core = Packages.arc.Core;
const Events = Packages.arc.Events;
const Log = Packages.arc.util.Log;
const Strings = Packages.arc.util.Strings;
const Align = Packages.arc.util.Align;
const Fi = Packages.arc.files.Fi;
const Http = Packages.arc.util.Http;
const Jval = Packages.arc.util.serialization.Jval;

const Base64Coder = Packages.arc.util.serialization.Base64Coder;
const CRC32 = Packages.java.util.zip.CRC32;
const MessageDigest = Packages.java.security.MessageDigest;
const ReflectArray = Packages.java.lang.reflect.Array;
const Runtime = Packages.java.lang.Runtime;
const System = Packages.java.lang.System;
const Runnable = Packages.java.lang.Runnable;
const Random = Packages.java.util.Random;
const AtomicBoolean = Packages.java.util.concurrent.atomic.AtomicBoolean;
const AtomicInteger = Packages.java.util.concurrent.atomic.AtomicInteger;
const AtomicLong = Packages.java.util.concurrent.atomic.AtomicLong;
const AtomicReference = Packages.java.util.concurrent.atomic.AtomicReference;
const ConcurrentHashMap = Packages.java.util.concurrent.ConcurrentHashMap;

const Cons = Packages.arc.func.Cons;

const Vars = Packages.mindustry.Vars;
const Pal = Packages.mindustry.graphics.Pal;
const Styles = Packages.mindustry.ui.Styles;
const Tex = Packages.mindustry.ui.Tex;

const BaseDialog = Packages.mindustry.ui.dialogs.BaseDialog;

const Icon = Packages.mindustry.gen.Icon;

const ClientLoadEvent = Packages.mindustry.game.EventType.ClientLoadEvent;
const ClientServerConnectEvent = Packages.mindustry.game.EventType.ClientServerConnectEvent;
const Trigger = Packages.mindustry.game.EventType.Trigger;

const STATE_KEY = "uuidmanager.state";
const UID_DB_KEY = "uuidmanager.uiddb";
const UID_DB_FILE = "uuidmanager.uiddb.json";
const APPROVED_KEY = "uuidmanager.approved";
const JOIN_ROW_NAME = "uuidmanager-join-row";
const UPDATE_OWNER = "DeterMination-Wind";
const UPDATE_REPO = "uuidManager";
const UPDATE_MOD_NAME = "uuidmanager";
const UPDATE_IGNORE_KEY = "uuidmanager.update.ignore";
const UPDATE_LAST_AT_KEY = "uuidmanager.update.lastAt";
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const APPROVAL_CODE_XOR = [
    9, 43, 43, 190, 197, 232, 139, 156, 130, 163, 48, 126,
    67, 127, 37, 44, 9, 21, 188, 220, 205, 135, 169, 148,
    151, 54, 67, 77, 123, 30, 11, 58, 55, 218, 203, 250,
    237, 131, 208, 167, 80, 81, 112, 66, 19, 13, 80, 63
];
const UID_GEN_WARNING = "1.uuid\u76f8\u540c\u5e76\u4e0d\u80fd\u83b7\u5f97\u4ed6\u4eba\u7ba1\u7406\u6743\u9650\n2.\u6ee5\u7528\u8be5\u529f\u80fd\u4f1a\u5bfc\u81f4Wayzer\u6539\u53d8uuid\u8ba1\u7b97\u7b56\u7565\uff0c\u614e\u7528\n3.\u7528\u8be5\u5de5\u5177\u4f2a\u88c5\u4ed6\u4eba\u7684\u4e00\u5f8b\u7b97\u50bb\u903c";

let _sha1Digest = null;
let _md5Digest = null;
let _uidTargetCache = null;
let _uidBuildRunning = false;
let _uidDbCache = null;
let _uidDbMetaText = "";
let _approvalCodeCache = null;
let _updateChecked = false;
let _latestReleaseInfo = null;

function tr(key){
    // Mindustry UI treats strings starting with '@' as bundle keys in many helpers,
    // but for our own strings we often want direct access.
    return Core.bundle.get(key, key);
}

function toast(text){
    try{
        Vars.ui.showInfoToast(text, 2.5);
    }catch(e){
        // Fallback for older builds.
        Log.info(text);
    }
}

function popupInfo(text){
    try{
        Vars.ui.showInfo("" + text);
    }catch(e){
        Log.info("" + text);
    }
}

function saveSettingsCompat(){
    try{
        if(Core.settings == null) return;
        if(typeof Core.settings.manualSave === "function"){
            Core.settings.manualSave();
        }else if(typeof Core.settings.forceSave === "function"){
            Core.settings.forceSave();
        }else if(typeof Core.settings.save === "function"){
            Core.settings.save();
        }else if(typeof Core.settings.autosave === "function"){
            Core.settings.autosave();
        }
    }catch(e){
        // ignore compatibility failures; settings are still put() into memory.
    }
}

function normalizeVersion(raw){
    let s = "" + (raw == null ? "" : raw);
    s = s.trim();
    if(s.startsWith("v") || s.startsWith("V")) s = s.substring(1).trim();
    return s;
}

function parseVersionParts(v){
    const s = normalizeVersion(v);
    const m = s.match(/\d+/g);
    if(m == null) return [];
    const out = [];
    for(let i = 0; i < m.length; i++){
        const n = parseInt(m[i], 10);
        if(!isNaN(n)) out.push(n);
    }
    return out;
}

function compareVersions(a, b){
    const pa = parseVersionParts(a);
    const pb = parseVersionParts(b);
    const max = Math.max(pa.length, pb.length);
    for(let i = 0; i < max; i++){
        const ai = i < pa.length ? pa[i] : 0;
        const bi = i < pb.length ? pb[i] : 0;
        if(ai !== bi) return ai > bi ? 1 : -1;
    }
    return 0;
}

function formatBytes(bytes){
    const b = Number(bytes || 0);
    if(!(b > 0)) return "";
    const mb = b / 1024 / 1024;
    if(mb < 10) return Strings.autoFixed(mb, 2) + "MB";
    if(mb < 100) return Strings.autoFixed(mb, 1) + "MB";
    return Math.floor(mb) + "MB";
}

function getCurrentModVersion(){
    try{
        if(Vars.mods == null) return "";
        const mod = Vars.mods.getMod(UPDATE_MOD_NAME);
        if(mod == null || mod.meta == null) return "";
        return normalizeVersion(mod.meta.version || "");
    }catch(e){
        return "";
    }
}

function getUpdateApiUrl(){
    return "https://api.github.com/repos/" + UPDATE_OWNER + "/" + UPDATE_REPO + "/releases/latest";
}

function getReleasePageUrl(){
    return "https://github.com/" + UPDATE_OWNER + "/" + UPDATE_REPO + "/releases";
}

function parseLatestRelease(json){
    if(json == null || !json.isObject()) return null;
    const tag = normalizeVersion(json.getString("tag_name", ""));
    const name = "" + json.getString("name", "");
    const version = tag.length > 0 ? tag : normalizeVersion(name);
    if(version.length === 0) return null;

    const htmlUrl = "" + json.getString("html_url", getReleasePageUrl());
    const body = "" + json.getString("body", "");
    const publishedAt = "" + json.getString("published_at", "");
    const pre = !!json.getBool("prerelease", false);
    const assets = [];

    try{
        const arrVal = json.get("assets");
        if(arrVal != null && arrVal.isArray()){
            const arr = arrVal.asArray();
            for(let i = 0; i < arr.size; i++){
                const a = arr.get(i);
                if(a == null || !a.isObject()) continue;
                const aname = "" + a.getString("name", "");
                const aurl = "" + a.getString("browser_download_url", "");
                const asize = Number(a.getLong("size", -1));
                if(aname.length === 0 || aurl.length === 0) continue;
                assets.push({name: aname, url: aurl, sizeBytes: asize});
            }
        }
    }catch(e){
        // ignore malformed assets
    }

    return {
        version: version,
        tag: tag,
        name: name,
        htmlUrl: htmlUrl,
        body: body,
        publishedAt: publishedAt,
        preRelease: pre,
        assets: assets
    };
}

function pickDefaultReleaseAsset(rel){
    if(rel == null || !Array.isArray(rel.assets) || rel.assets.length === 0) return null;
    const mobile = !!Vars.mobile;
    if(mobile){
        for(let i = 0; i < rel.assets.length; i++){
            const n = rel.assets[i].name.toLowerCase();
            if(n.endsWith(".jar")) return rel.assets[i];
        }
    }else{
        for(let i = 0; i < rel.assets.length; i++){
            const n = rel.assets[i].name.toLowerCase();
            if(n.endsWith(".zip")) return rel.assets[i];
        }
    }
    return rel.assets[0];
}

function downloadReleaseAsset(rel, asset){
    if(rel == null || asset == null || !asset.url){
        popupInfo("\u6ca1\u6709\u53ef\u7528\u7684\u4e0b\u8f7d\u6587\u4ef6");
        return;
    }

    const tmpDir = Vars.tmpDirectory.child("uuidmanager-update");
    tmpDir.mkdirs();
    const tmpFile = tmpDir.child(asset.name);
    const finalFile = Vars.modDirectory.child(asset.name);

    const canceled = {v: false};
    const readBytes = {v: 0};
    const totalBytes = {v: Math.max(0, Number(asset.sizeBytes || 0))};

    const d = new BaseDialog("\u4e0b\u8f7d\u66f4\u65b0");
    d.closeOnBack();
    d.cont.table(cons(t => {
        t.left();
        t.defaults().left().pad(6);
        t.add(() => {
            const mb = readBytes.v / 1024 / 1024;
            if(totalBytes.v > 0){
                const ratio = Math.max(0, Math.min(1, readBytes.v / totalBytes.v));
                return "\u4e0b\u8f7d: " + asset.name + "\n" +
                    Strings.autoFixed(ratio * 100, 1) + "%  (" + Strings.autoFixed(mb, 2) + "/" + Strings.autoFixed(totalBytes.v / 1024 / 1024, 2) + " MB)";
            }
            return "\u4e0b\u8f7d: " + asset.name + "\n" + Strings.autoFixed(mb, 2) + " MB";
        }).wrap().width(680);
    })).growX().row();
    d.buttons.defaults().size(180, 54).pad(4);
    d.buttons.button("\u53d6\u6d88", () => {
        canceled.v = true;
        d.hide();
    });
    d.show();

    Http.get(asset.url)
        .timeout(30000)
        .header("User-Agent", "Mindustry")
        .error(e => Core.app.post(() => {
            try{ d.hide(); }catch(err){ }
            popupInfo("\u4e0b\u8f7d\u5931\u8d25");
        }))
        .submit(res => {
            let input = null;
            let out = null;
            try{
                const len = Number(res.getContentLength());
                if(len > 0) totalBytes.v = len;
                input = res.getResultAsStream();
                out = tmpFile.write(false, 1024 * 256);
                const buf = ReflectArray.newInstance(Packages.java.lang.Byte.TYPE, 1024 * 128);
                while(true){
                    if(canceled.v) break;
                    const r = input.read(buf);
                    if(r < 0) break;
                    out.write(buf, 0, r);
                    readBytes.v += r;
                }
                try{ out.flush(); }catch(e){ }
            }catch(e){
                try{ if(tmpFile.exists()) tmpFile.delete(); }catch(err){ }
                Core.app.post(() => {
                    try{ d.hide(); }catch(err){ }
                    popupInfo("\u4e0b\u8f7d\u5931\u8d25");
                });
                return;
            }finally{
                try{ if(out != null) out.close(); }catch(e){ }
                try{ if(input != null) input.close(); }catch(e){ }
            }

            if(canceled.v){
                try{ if(tmpFile.exists()) tmpFile.delete(); }catch(e){ }
                return;
            }

            Core.app.post(() => {
                try{ d.hide(); }catch(err){ }
                try{
                    tmpFile.copyTo(finalFile);
                    try{ tmpFile.delete(); }catch(e){ }
                    popupInfo("\u4e0b\u8f7d\u5b8c\u6210\uff0c\u5df2\u5199\u5165:\n" + finalFile.absolutePath() + "\n\u8bf7\u91cd\u542f\u6e38\u620f\u751f\u6548");
                }catch(e){
                    popupInfo("\u5df2\u4e0b\u8f7d\u5230\u4e34\u65f6\u6587\u4ef6:\n" + tmpFile.absolutePath() + "\n\u8bf7\u624b\u52a8\u590d\u5236\u5230mods\u76ee\u5f55");
                }
            });
        });
}

function showUpdateDialog(current, rel, fromManual){
    if(rel == null) return;
    const dialog = new BaseDialog("UUID Manager \u66f4\u65b0");
    dialog.addCloseButton();
    dialog.closeOnBack();

    dialog.cont.table(cons(t => {
        t.left();
        t.defaults().left().pad(4);
        t.add("\u5f53\u524d\u7248\u672c: " + current).color(Pal.lightishGray).row();
        t.add("\u6700\u65b0\u7248\u672c: " + rel.version + (rel.preRelease ? " (pre)" : "")).color(Pal.accent).row();
        if(rel.publishedAt && rel.publishedAt.length > 0){
            t.add("\u53d1\u5e03\u65f6\u95f4: " + rel.publishedAt).color(Pal.lightishGray).row();
        }
        if(rel.body && rel.body.length > 0){
            t.add("\u66f4\u65b0\u8bf4\u660e:").padTop(6).row();
            t.pane(cons(p => {
                p.add(rel.body).wrap().left().growX();
            })).width(720).height(Math.min(300, Core.graphics.getHeight() * 0.35)).row();
        }
    })).growX().row();

    if(Array.isArray(rel.assets) && rel.assets.length > 0){
        dialog.cont.table(cons(t => {
            t.left();
            t.defaults().left().pad(4);
            t.add("\u4e0b\u8f7d\u6587\u4ef6:").padTop(8).row();
            for(let i = 0; i < rel.assets.length; i++){
                const a = rel.assets[i];
                const suffix = formatBytes(a.sizeBytes);
                const label = suffix.length > 0 ? (a.name + " (" + suffix + ")") : a.name;
                t.button(label, Styles.cleart, () => downloadReleaseAsset(rel, a)).width(720).height(44).left().row();
            }
        })).growX().row();
    }

    dialog.buttons.defaults().size(200, 54).pad(4);
    dialog.buttons.button("\u6253\u5f00Release\u9875", Icon.link, () => Core.app.openURI(rel.htmlUrl || getReleasePageUrl()));
    dialog.buttons.button("\u5ffd\u7565\u6b64\u7248\u672c", Icon.cancel, () => {
        Core.settings.put(UPDATE_IGNORE_KEY, rel.version);
        saveSettingsCompat();
        dialog.hide();
    });
    if(fromManual){
        dialog.buttons.button("\u5173\u95ed", Icon.ok, () => dialog.hide());
    }
    dialog.show();
}

function resolveLatestRelease(manual){
    const api = getUpdateApiUrl();
    Http.get(api)
        .timeout(30000)
        .header("User-Agent", "Mindustry")
        .error(e => {
            if(manual){
                Core.app.post(() => popupInfo("\u68c0\u67e5\u66f4\u65b0\u5931\u8d25"));
            }
        })
        .submit(res => {
            let rel = null;
            try{
                rel = parseLatestRelease(Jval.read(res.getResultAsString()));
            }catch(e){
                rel = null;
            }
            if(rel == null){
                if(manual){
                    Core.app.post(() => popupInfo("\u672a\u80fd\u89e3\u6790\u6700\u65b0\u7248\u672c\u4fe1\u606f"));
                }
                return;
            }

            _latestReleaseInfo = rel;
            const current = getCurrentModVersion();
            const cmp = compareVersions(rel.version, current);
            const ignore = normalizeVersion(Core.settings.getString(UPDATE_IGNORE_KEY, ""));
            if(!manual && ignore.length > 0 && compareVersions(rel.version, ignore) <= 0) return;

            if(cmp > 0){
                Core.app.post(() => showUpdateDialog(current, rel, manual));
            }else if(manual){
                Core.app.post(() => popupInfo("\u5df2\u662f\u6700\u65b0\u7248\u672c: " + current));
            }
        });
}

function checkGithubUpdate(manual){
    if(Vars.headless) return;

    if(!manual){
        if(_updateChecked) return;
        _updateChecked = true;
        const now = Number(System.currentTimeMillis());
        const last = Number(Core.settings.getLong(UPDATE_LAST_AT_KEY, 0));
        if(last > 0 && now - last < UPDATE_INTERVAL_MS) return;
        Core.settings.put(UPDATE_LAST_AT_KEY, now);
        saveSettingsCompat();
    }

    resolveLatestRelease(!!manual);
}

function getUpdateStatusText(){
    const cur = getCurrentModVersion();
    const latest = _latestReleaseInfo == null ? "-" : _latestReleaseInfo.version;
    return "\u5f53\u524d\u7248\u672c: " + cur + "\n\u6700\u65b0\u7248\u672c: " + latest;
}

function getApprovalCode(){
    if(_approvalCodeCache != null) return _approvalCodeCache;
    let out = "";
    for(let i = 0; i < APPROVAL_CODE_XOR.length; i++){
        const mask = (i * 17 + 91) & 0xff;
        out += String.fromCharCode((APPROVAL_CODE_XOR[i] ^ mask) & 0xff);
    }
    _approvalCodeCache = out;
    return out;
}

function cons(fn){
    // Rhino overload resolution: a JS function can match multiple functional interfaces.
    // Wrap it as an explicit arc.func.Cons to avoid ambiguity (e.g. Table.table(Cons) vs Table.table(Drawable)).
    return new Cons({get: function(arg){ fn(arg); }});
}

function safeParseJson(text, fallback){
    try{
        if(text == null) return fallback;
        const s = ("" + text).trim();
        if(s.length === 0) return fallback;
        return JSON.parse(s);
    }catch(e){
        return fallback;
    }
}

function defaultState(){
    return {
        autoSwitch: true,
        saved: [],
        serverRules: []
    };
}

function loadState(){
    const raw = Core.settings.getString(STATE_KEY, "");
    const state = safeParseJson(raw, defaultState());
    if(typeof state !== "object" || state == null) return defaultState();
    if(!Array.isArray(state.saved)) state.saved = [];
    if(!Array.isArray(state.serverRules)) state.serverRules = [];
    if(typeof state.autoSwitch !== "boolean") state.autoSwitch = true;

    // Best-effort normalization (do not auto-save here).
    for(let i = 0; i < state.saved.length; i++){
        const e = state.saved[i];
        if(!e || typeof e !== "object") continue;
        const norm = normalizeUuidOrUid(e.uuid8 || "");
        if(norm.valid) e.uuid8 = norm.uuid8;
    }
    for(let i = 0; i < state.serverRules.length; i++){
        const r = state.serverRules[i];
        if(!r || typeof r !== "object") continue;
        r.server = normalizeServerKeyInput(r.server || "");
        const norm = normalizeUuidOrUid(r.uuid8 || "");
        if(norm.valid) r.uuid8 = norm.uuid8;
    }

    return state;
}

function saveState(state){
    try{
        Core.settings.put(STATE_KEY, JSON.stringify(state));
        saveSettingsCompat();
    }catch(e){
        Log.err("[uuidmanager] Failed to save state.");
        Log.err(e);
    }
}

function isApproved(){
    try{
        return !!Core.settings.getBool(APPROVED_KEY, false);
    }catch(e){
        return false;
    }
}

function setApproved(v){
    try{
        Core.settings.put(APPROVED_KEY, !!v);
        saveSettingsCompat();
    }catch(e){
        // ignore
    }
}

function defaultUidDb(){
    return {
        map: {},
        meta: {
            targetCount: 0,
            foundCount: 0,
            excludedSpecialCount: 0,
            excludedTimeoutCount: 0,
            checked: 0,
            cores: 0,
            lastBuildAt: 0,
            lastBuildSec: 8
        }
    };
}

function getUidDbFi(){
    try{
        if(Vars == null || Vars.dataDirectory == null) return null;
        return Vars.dataDirectory.child(UID_DB_FILE);
    }catch(e){
        return null;
    }
}

function uidDbMetaText(db){
    const m = (db && db.meta) ? db.meta : {};
    const found = Number(m.foundCount || 0);
    const longIds = Number(m.longIdCount || 0);
    const total = Number(m.targetCount || 0);
    const timeout = Number(m.excludedTimeoutCount || 0);
    const cores = Number(m.cores || 0);
    const checked = Number(m.checked || 0);
    return "\u6570\u636e\u5e93\u7edf\u8ba1:\n" +
        "  \u2022 \u77edUID\u8986\u76d6: " + found + "/" + total + "\n" +
        "  \u2022 \u957fid\u603b\u6761\u6570: " + longIds + "\n" +
        "  \u2022 \u8d85\u65f6\u6392\u9664: " + timeout + "\n" +
        "  \u2022 \u4e0a\u6b21\u6784\u5efa\u6838\u5fc3\u6570: " + cores + "\n" +
        "  \u2022 \u7d2f\u8ba1\u5c1d\u8bd5\u6b21\u6570: " + checked;
}

function formatUidDbPrettyJson(db){
    const out = {meta: db.meta || {}, map: {}};
    const keys = Object.keys(db.map || {}).sort();
    for(let i = 0; i < keys.length; i++){
        const k = keys[i];
        const list = uidListFromRaw(db.map[k]);
        if(list.length === 0) continue;
        const sorted = list.slice().sort();
        out.map[k] = sorted;
    }
    return JSON.stringify(out, null, 2);
}

function summarizeImportResult(result){
    return (result.message || "\u5bfc\u5165\u5b8c\u6210") + "\n" +
        "\u65b0\u589e: " + Number(result.added || 0) + "\n" +
        "\u91cd\u590d: " + Number(result.duplicate || 0) + "\n" +
        "\u65e0\u6548: " + Number(result.invalid || 0) + "\n" +
        "UID\u4e0d\u5339\u914d: " + Number(result.mismatch || 0);
}

function normalizeUidKey(uid3){
    const k = sanitizeIdText(uid3);
    return k.length === 3 ? k : "";
}

function uidListFromRaw(raw){
    const out = [];
    if(raw == null) return out;

    if(Array.isArray(raw)){
        for(let i = 0; i < raw.length; i++){
            const v = sanitizeIdText(raw[i]);
            if(v.length > 0) out.push(v);
        }
        return out;
    }

    const s = sanitizeIdText(raw);
    if(s.length > 0) out.push(s);
    return out;
}

function ensureUidList(db, key){
    const k = normalizeUidKey(key);
    if(k.length !== 3) return [];

    let list = db.map[k];
    if(Array.isArray(list)) return list;

    list = uidListFromRaw(list);
    db.map[k] = list;
    return list;
}

function addUidPair(db, uid3, uuid8){
    const key = normalizeUidKey(uid3);
    const val = sanitizeIdText(uuid8);
    if(key.length !== 3 || val.length === 0) return false;

    const list = ensureUidList(db, key);
    for(let i = 0; i < list.length; i++){
        if(list[i] === val) return false;
    }
    list.push(val);
    return true;
}

function getUidListByUid(uid3){
    const key = normalizeUidKey(uid3);
    if(key.length !== 3) return [];

    const db = loadUidDb();
    const raw = db.map[key];
    if(Array.isArray(raw)) return raw;
    return uidListFromRaw(raw);
}

function recomputeUidDbMeta(db, patch){
    const targetInfo = getAllUidTargets();
    const meta = db.meta || {};

    let foundCount = 0;
    let longIdCount = 0;
    for(let i = 0; i < targetInfo.targets.length; i++){
        const key = targetInfo.targets[i];
        const list = uidListFromRaw(db.map[key]);
        if(list.length > 0){
            foundCount++;
            longIdCount += list.length;
            db.map[key] = list;
        }
    }

    db.meta = {
        targetCount: targetInfo.targets.length,
        foundCount: foundCount,
        excludedSpecialCount: targetInfo.excludedSpecial,
        excludedTimeoutCount: Math.max(0, targetInfo.targets.length - foundCount),
        longIdCount: longIdCount,
        checked: Number(meta.checked || 0),
        cores: Number(meta.cores || 0),
        lastBuildAt: Number(meta.lastBuildAt || 0),
        lastBuildSec: Number(meta.lastBuildSec || 8)
    };

    if(patch && typeof patch === "object"){
        for(var k in patch){
            if(Object.prototype.hasOwnProperty.call(patch, k)) db.meta[k] = patch[k];
        }
    }
}

function getUidDbMetaText(){
    if(_uidDbMetaText.length > 0) return _uidDbMetaText;
    const db = loadUidDb();
    return uidDbMetaText(db);
}

function loadUidDb(){
    if(_uidDbCache != null) return _uidDbCache;

    let db = null;
    let migratedFromSettings = false;

    try{
        const fi = getUidDbFi();
        if(fi != null && fi.exists()){
            db = safeParseJson(fi.readString(), null);
        }
    }catch(e){
        db = null;
    }

    if(typeof db !== "object" || db == null){
        const raw = Core.settings.getString(UID_DB_KEY, "");
        db = safeParseJson(raw, null);
        migratedFromSettings = (typeof db === "object" && db != null);
    }

    if(typeof db !== "object" || db == null){
        _uidDbCache = defaultUidDb();
        _uidDbMetaText = uidDbMetaText(_uidDbCache);
        return _uidDbCache;
    }
    if(typeof db.map !== "object" || db.map == null || Array.isArray(db.map)) db.map = {};
    if(typeof db.meta !== "object" || db.meta == null) db.meta = defaultUidDb().meta;

    // Ensure values are arrays of plain strings and keys are 3-char IDs.
    const clean = {};
    for(var k in db.map){
        if(!Object.prototype.hasOwnProperty.call(db.map, k)) continue;
        const key = normalizeUidKey(k);
        if(key.length !== 3) continue;
        const list = uidListFromRaw(db.map[k]);
        if(list.length === 0) continue;

        const uniq = [];
        for(let i = 0; i < list.length; i++){
            const v = list[i];
            let exists = false;
            for(let j = 0; j < uniq.length; j++){
                if(uniq[j] === v){ exists = true; break; }
            }
            if(!exists) uniq.push(v);
        }
        clean[key] = uniq;
    }
    db.map = clean;
    recomputeUidDbMeta(db);

    // One-time migration from Arc settings string storage to external JSON file.
    if(migratedFromSettings){
        try{
            const fi = getUidDbFi();
            if(fi != null){
                fi.writeString(JSON.stringify(db), false);
            }
            Core.settings.remove(UID_DB_KEY);
            saveSettingsCompat();
        }catch(e){
            // keep working from memory even if migration write fails
        }
    }

    _uidDbCache = db;
    _uidDbMetaText = uidDbMetaText(db);
    return db;
}

function saveUidDb(db){
    try{
        _uidDbCache = db;
        _uidDbMetaText = uidDbMetaText(db);
        const fi = getUidDbFi();
        if(fi == null){
            return false;
        }
        fi.writeString(JSON.stringify(db), false);
        return true;
    }catch(e){
        Log.err("[uuidmanager] Failed to save uid db.");
        Log.err(e);
        return false;
    }
}

function exportUidDbToFile(pathText){
    const db = loadUidDb();
    recomputeUidDbMeta(db);

    const path = ("" + (pathText == null ? "" : pathText)).trim();
    const fi = path.length > 0 ? new Fi(path) : Vars.dataDirectory.child("uuidmanager.uiddb.export.json");
    fi.writeString(formatUidDbPrettyJson(db), false);
    return fi.absolutePath();
}

function importUidDbFromFile(pathText){
    const path = ("" + (pathText == null ? "" : pathText)).trim();
    if(path.length === 0) return {ok: false, message: "\u8bf7\u8f93\u5165\u6587\u4ef6\u8def\u5f84"};

    const fi = new Fi(path);
    if(!fi.exists()) return {ok: false, message: "\u6587\u4ef6\u4e0d\u5b58\u5728"};

    try{
        const text = fi.readString();
        return importUidDbText(text);
    }catch(e){
        return {ok: false, message: "\u8bfb\u53d6\u6587\u4ef6\u5931\u8d25"};
    }
}

function mapShortChar(c){
    if(c === "k") return "K";
    if(c === "S") return "s";
    if(c === "l") return "L";
    if(c === "+") return "A";
    if(c === "/") return "B";
    return c;
}

function isAllSpecialUid(uid3){
    const s = "" + (uid3 == null ? "" : uid3);
    if(s.length !== 3) return false;
    for(let i = 0; i < 3; i++){
        const c = s.charCodeAt(i);
        const isNum = (c >= 48 && c <= 57);
        const isUpper = (c >= 65 && c <= 90);
        const isLower = (c >= 97 && c <= 122);
        if(isNum || isUpper || isLower){
            return false;
        }
    }
    return true;
}

function getAllUidTargets(){
    if(_uidTargetCache != null) return _uidTargetCache;

    const raw = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const uniq = {};
    for(let i = 0; i < raw.length; i++){
        uniq[mapShortChar(raw.charAt(i))] = true;
    }

    const chars = Object.keys(uniq).sort();
    const arr = [];
    let excludedSpecial = 0;

    for(let i = 0; i < chars.length; i++){
        for(let j = 0; j < chars.length; j++){
            for(let k = 0; k < chars.length; k++){
                const id = chars[i] + chars[j] + chars[k];
                if(isAllSpecialUid(id)){
                    excludedSpecial++;
                    continue;
                }
                arr.push(id);
            }
        }
    }

    _uidTargetCache = {targets: arr, excludedSpecial: excludedSpecial};
    return _uidTargetCache;
}

function lookupUuid8ByUid(uid3){
    const list = getUidListByUid(uid3);
    return list.length > 0 ? sanitizeIdText(list[0]) : "";
}

function sanitizeIdText(text){
    if(text == null) return "";
    // remove whitespace (users often copy/paste with newlines)
    return ("" + text).trim().replace(/\s+/g, "");
}

function padBase64(text){
    const s = sanitizeIdText(text);
    const mod = s.length % 4;
    if(mod === 0) return s;
    if(mod === 2) return s + "==";
    if(mod === 3) return s + "=";
    // mod === 1 is invalid for standard Base64.
    return s;
}

function b64Decode(text){
    try{
        return Base64Coder.decode(text);
    }catch(e){
        return null;
    }
}

function b64Encode(bytes){
    // Coerce java.lang.String -> JS string.
    // Rhino JSON.stringify can blow up when given NativeJavaObject values.
    return "" + new Packages.java.lang.String(Base64Coder.encode(bytes));
}

function toSignedByte(u8){
    const v = (u8 & 0xff);
    return v > 127 ? (v - 256) : v;
}

function sha1Hex(text){
    try{
        if(_sha1Digest == null){
            _sha1Digest = MessageDigest.getInstance("SHA-1");
        }
        const input = new Packages.java.lang.String("" + (text == null ? "" : text));
        const dig = _sha1Digest.digest(input.getBytes(Strings.utf8));
        let out = "";
        for(let i = 0; i < dig.length; i++){
            const v = (dig[i] & 0xff);
            let h = v.toString(16);
            if(h.length === 1) h = "0" + h;
            out += h;
        }
        return out;
    }catch(e){
        return "";
    }
}

function shortStrFromUid16WithDigest(uid16, digest){
    // Wayzer shortID algorithm: base64(md5(md5(uid16)+uid16))[0..2] with safe-char remap.
    const s = sanitizeIdText(uid16);
    if(s.length === 0) return "";

    try{
        const input = new Packages.java.lang.String(s);
        const bs = input.getBytes(Strings.utf8);
        if(digest == null) return "";

        digest.reset();
        const first = digest.digest(bs);

        const mixed = ReflectArray.newInstance(Packages.java.lang.Byte.TYPE, first.length + bs.length);
        for(let i = 0; i < first.length; i++) mixed[i] = first[i];
        for(let i = 0; i < bs.length; i++) mixed[first.length + i] = bs[i];

        digest.reset();
        const second = digest.digest(mixed);

        const b64 = b64Encode(second);
        if(b64.length < 3) return "";

        let out = "";
        for(let i = 0; i < 3; i++){
            out += mapShortChar(b64.charAt(i));
        }
        return out;
    }catch(e){
        return "";
    }
}

function shortStrFromUid16(uid16){
    try{
        if(_md5Digest == null){
            _md5Digest = MessageDigest.getInstance("MD5");
        }
        return shortStrFromUid16WithDigest(uid16, _md5Digest);
    }catch(e){
        return "";
    }
}

function findUuid8ByUidShortParallel(targetUid, onDone){
    const target = sanitizeIdText(targetUid);
    if(target.length !== 3){
        Core.app.post(() => onDone({ok: false, error: "invalid", target: target}));
        return;
    }

    const cores = Math.max(1, Number(Runtime.getRuntime().availableProcessors()));
    const perWorkerLimit = 4000000;

    const stop = new AtomicBoolean(false);
    const finished = new AtomicInteger(0);
    const checked = new AtomicLong(0);
    const foundUuid8 = new AtomicReference(null);

    const finishIfDone = () => {
        if(finished.incrementAndGet() !== cores) return;
        const uuid8 = foundUuid8.get();
        Core.app.post(() => {
            try{
                onDone({
                    ok: uuid8 != null,
                    uuid8: uuid8 == null ? "" : ("" + uuid8),
                    target: target,
                    checked: Number(checked.get()),
                    cores: cores
                });
            }catch(e){
                Log.err(e);
            }
        });
    };

    for(let wid = 0; wid < cores; wid++){
        const workerId = wid;
        const worker = new Runnable({
            run: function(){
                let localChecked = 0;
                try{
                    const seed = Number(System.nanoTime()) + workerId * 1315423911;
                    const rng = new Random(seed);
                    const digest = MessageDigest.getInstance("MD5");
                    const uuidBytes = ReflectArray.newInstance(Packages.java.lang.Byte.TYPE, 8);

                    for(let i = 0; i < perWorkerLimit && !stop.get(); i++){
                        rng.nextBytes(uuidBytes);
                        const uidBytes = computeUidBytesFromUuidBytes(uuidBytes);
                        if(uidBytes == null) continue;
                        const uid16 = b64Encode(uidBytes);
                        const sid = shortStrFromUid16WithDigest(uid16, digest);
                        localChecked++;

                        if(sid === target){
                            const uuid8 = b64Encode(uuidBytes);
                            if(stop.compareAndSet(false, true)){
                                foundUuid8.set(uuid8);
                            }
                            break;
                        }

                        if((localChecked & 2047) === 0){
                            checked.addAndGet(2048);
                            localChecked -= 2048;
                        }
                    }
                }catch(e){
                    // worker failure should not kill whole feature
                }finally{
                    if(localChecked > 0) checked.addAndGet(localChecked);
                    finishIfDone();
                }
            }
        });

        const thread = new Packages.java.lang.Thread(worker, "uuidmanager-uid-search-" + workerId);
        thread.setDaemon(true);
        thread.start();
    }
}

function buildUidDbAll8s(onDone, onProgress){
    if(_uidBuildRunning){
        toast("[accent]UID\u6570\u636e\u5e93\u6784\u5efa\u4e2d...[]");
        return;
    }

    const dbBase = loadUidDb();
    const targetInfo = getAllUidTargets();
    const totalTargets = targetInfo.targets.length;
    const existingCovered = new ConcurrentHashMap();
    let existingCount = 0;
    for(let i = 0; i < targetInfo.targets.length; i++){
        const k = targetInfo.targets[i];
        const list = uidListFromRaw(dbBase.map[k]);
        if(list.length > 0){
            existingCovered.put(k, true);
            existingCount++;
        }
    }

    _uidBuildRunning = true;
    const runMillis = 8000;
    const cores = Math.max(1, Number(Runtime.getRuntime().availableProcessors()));
    const deadline = Number(System.currentTimeMillis()) + runMillis;
    const checked = new AtomicLong(0);
    const finished = new AtomicInteger(0);
    const step = 500000;
    const maxFoundPairs = 200000;
    const foundPairs = new ConcurrentHashMap();
    const newCovered = new ConcurrentHashMap();

    if(typeof onProgress === "function"){
        try{
            onProgress({checked: 0, covered: existingCount, total: totalTargets});
        }catch(e){ }
    }

    for(let wid = 0; wid < cores; wid++){
        const workerId = wid;
        const worker = new Runnable({
            run: function(){
                let localChecked = 0;
                try{
                    const seed = Number(System.nanoTime()) + workerId * 1103515245;
                    const rng = new Random(seed);
                    const digest = MessageDigest.getInstance("MD5");
                    const uuidBytes = ReflectArray.newInstance(Packages.java.lang.Byte.TYPE, 8);

                    while(Number(System.currentTimeMillis()) < deadline){
                        rng.nextBytes(uuidBytes);
                        const uidBytes = computeUidBytesFromUuidBytes(uuidBytes);
                        if(uidBytes == null) continue;

                        const uid16 = b64Encode(uidBytes);
                        const sid = shortStrFromUid16WithDigest(uid16, digest);
                        if(sid.length === 3 && !isAllSpecialUid(sid)){
                            if(foundPairs.size() < maxFoundPairs){
                                const pairKey = sid + "|" + b64Encode(uuidBytes);
                                foundPairs.putIfAbsent(pairKey, true);
                            }
                            if(!existingCovered.containsKey(sid)){
                                newCovered.putIfAbsent(sid, true);
                            }
                        }
                        localChecked++;
                        if(localChecked >= step){
                            checked.addAndGet(localChecked);
                            localChecked = 0;
                        }
                    }
                }catch(e){
                    // ignore single worker failure
                }finally{
                    if(localChecked > 0) checked.addAndGet(localChecked);
                    finished.incrementAndGet();
                }
            }
        });

        const thread = new Packages.java.lang.Thread(worker, "uuidmanager-uiddb-build-" + workerId);
        thread.setDaemon(true);
        thread.start();
    }

    const waiter = new Runnable({
        run: function(){
            let lastStep = -1;
            let lastCovered = -1;
            while(finished.get() < cores){
                const c = Number(checked.get());
                const coveredNow = Math.min(totalTargets, existingCount + newCovered.size());
                const stepNow = Math.floor(c / step);
                if(typeof onProgress === "function" && (stepNow !== lastStep || coveredNow !== lastCovered)){
                    lastStep = stepNow;
                    lastCovered = coveredNow;
                    Core.app.post(() => {
                        try{ onProgress({checked: c, covered: coveredNow, total: totalTargets}); }catch(e){ }
                    });
                }
                try{ Packages.java.lang.Thread.sleep(50); }catch(e){ }
            }

            if(typeof onProgress === "function"){
                const c = Number(checked.get());
                const coveredNow = Math.min(totalTargets, existingCount + newCovered.size());
                Core.app.post(() => {
                    try{ onProgress({checked: c, covered: coveredNow, total: totalTargets}); }catch(e){ }
                });
            }

            Core.app.post(() => {
                try{
                    const db = loadUidDb();
                    const iter = foundPairs.keySet().iterator();
                    let addedPairs = 0;
                    while(iter.hasNext()){
                        const pair = "" + iter.next();
                        const sep = pair.indexOf("|");
                        if(sep <= 0 || sep >= pair.length - 1) continue;
                        const k = pair.substring(0, sep);
                        const v = pair.substring(sep + 1);
                        if(addUidPair(db, k, v)){
                            addedPairs++;
                        }
                    }

                    recomputeUidDbMeta(db, {
                        checked: Number(checked.get()),
                        cores: cores,
                        lastBuildAt: Number(System.currentTimeMillis()),
                        lastBuildSec: 8,
                        lastAddedPairs: addedPairs
                    });

                    const saved = saveUidDb(db);
                    _uidBuildRunning = false;

                    if(typeof onDone === "function"){
                        onDone({ok: saved, meta: db.meta});
                    }
                }catch(e){
                    _uidBuildRunning = false;
                    if(typeof onDone === "function") onDone({ok: false, error: "save"});
                }
            });
        }
    });

    const waiterThread = new Packages.java.lang.Thread(waiter, "uuidmanager-uiddb-waiter");
    waiterThread.setDaemon(true);
    waiterThread.start();
}

function tryCollectImportedPairsFromObject(obj, out){
    if(obj == null || typeof obj !== "object") return;

    if(Array.isArray(obj)){
        for(let i = 0; i < obj.length; i++){
            const it = obj[i];
            if(it == null) continue;
            if(typeof it === "string") continue;
            if(typeof it !== "object") continue;

            const uid = normalizeUidKey(it.uid3 || it.uid || it.id || it.shortId || it.shortid || "");
            const raw = it.uuid8 || it.uuid || it.longUuid || it.longuuid || it.value || "";
            if(uid.length === 3 && ("" + raw).length > 0){
                out.push({uid: uid, raw: "" + raw});
            }
        }
        return;
    }

    if(obj.map && typeof obj.map === "object"){
        const mp = obj.map;
        for(var k in mp){
            if(!Object.prototype.hasOwnProperty.call(mp, k)) continue;
            const uid = normalizeUidKey(k);
            if(uid.length !== 3) continue;
            const vals = uidListFromRaw(mp[k]);
            for(let i = 0; i < vals.length; i++){
                out.push({uid: uid, raw: vals[i]});
            }
        }
    }
}

function tryCollectImportedPairsFromLines(text, out){
    const lines = ("" + text).split(/\r?\n/);
    for(let i = 0; i < lines.length; i++){
        const ln = lines[i].trim();
        if(ln.length === 0) continue;
        if(ln.startsWith("#")) continue;

        // Accept formats like:
        // uid uuid
        // uid: uuid
        // uid => uuid
        const m = ln.match(/^([^\s:=><,]{3})\s*(?:[:=><,\-]+\s*)?([A-Za-z0-9+/=]+)$/);
        if(m == null) continue;

        const uid = normalizeUidKey(m[1]);
        const raw = sanitizeIdText(m[2]);
        if(uid.length !== 3 || raw.length === 0) continue;
        out.push({uid: uid, raw: raw});
    }
}

function importUidDbText(payload){
    const text = ("" + (payload == null ? "" : payload)).trim();
    if(text.length === 0){
        return {ok: false, message: "\u7c98\u8d34\u677f\u4e3a\u7a7a"};
    }

    const pairs = [];
    let jsonObj = null;
    try{
        jsonObj = JSON.parse(text);
    }catch(e){
        jsonObj = null;
    }

    if(jsonObj != null){
        tryCollectImportedPairsFromObject(jsonObj, pairs);
    }else{
        tryCollectImportedPairsFromLines(text, pairs);
    }

    if(pairs.length === 0){
        return {ok: false, message: "\u672a\u8bc6\u522b\u5230\u53ef\u5bfc\u5165\u8bb0\u5f55"};
    }

    const db = loadUidDb();
    let added = 0;
    let duplicate = 0;
    let invalid = 0;
    let mismatch = 0;

    for(let i = 0; i < pairs.length; i++){
        const p = pairs[i];
        const norm = normalizeUuidOrUid(p.raw);
        if(!norm.valid){
            invalid++;
            continue;
        }

        const uuid8 = norm.uuid8;
        const sid = getUidShortForUuid8(uuid8);
        if(sid !== p.uid){
            mismatch++;
            continue;
        }

        if(addUidPair(db, p.uid, uuid8)){
            added++;
        }else{
            duplicate++;
        }
    }

    recomputeUidDbMeta(db, {
        lastImportAt: Number(System.currentTimeMillis()),
        lastImportAdded: added,
        lastImportDuplicate: duplicate,
        lastImportInvalid: invalid,
        lastImportMismatch: mismatch
    });

    const saved = saveUidDb(db);
    return {
        ok: saved,
        added: added,
        duplicate: duplicate,
        invalid: invalid,
        mismatch: mismatch,
        totalParsed: pairs.length,
        message: saved ? "\u5bfc\u5165\u5b8c\u6210" : "\u5bfc\u5165\u6210\u529f\u4f46\u4fdd\u5b58\u5931\u8d25"
    };
}

function showUidDbMatchListDialog(uid3, list){
    const dialog = new BaseDialog("UID\u67e5\u8be2: " + uid3);
    dialog.addCloseButton();
    dialog.closeOnBack();

    const pageSize = 120;
    let page = 0;
    const total = list.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));

    dialog.cont.table(cons(t => {
        t.left();
        t.defaults().left().pad(4);
        t.label(() => "\u5339\u914d\u5230\u957fid\u6570\u91cf: " + total + "  |  \u7b2c" + (page + 1) + "/" + pageCount + "\u9875")
            .color(Pal.accent).left().row();
    })).growX().padBottom(8).row();

    const content = new Packages.arc.scene.ui.layout.Table();
    content.top().left();
    content.defaults().growX().left();

    const rebuild = () => {
        content.clear();
        if(total === 0){
            content.add("\u65e0\u5339\u914d\u7ed3\u679c").color(Pal.gray).left();
            return;
        }

        const start = page * pageSize;
        const end = Math.min(total, start + pageSize);
        for(let i = start; i < end; i++){
            const v = "" + list[i];
            content.table(cons(row => {
                row.left();
                row.defaults().pad(4).left();
                row.add(v).color(Pal.lightishGray).growX();
                row.button(Icon.copySmall, Styles.cleari, () => {
                    Core.app.setClipboardText(v);
                    popupInfo("\u60a8\u5df2\u590d\u5236");
                }).size(44);
            })).padBottom(4).growX();
            content.row();
        }
    };

    rebuild();

    dialog.cont.pane(cons(p => {
        p.add(content).growX();
    })).grow().row();

    dialog.buttons.defaults().size(160, 54).pad(4);
    dialog.buttons.button("\u4e0a\u4e00\u9875", () => {
        if(page > 0){
            page--;
            rebuild();
        }
    });
    dialog.buttons.button("\u4e0b\u4e00\u9875", () => {
        if(page < pageCount - 1){
            page++;
            rebuild();
        }
    });

    dialog.show();
}

function showUidDbLookupDialog(){
    showPrompt("UID\u6570\u636e\u5e93\u67e5\u8be2", "\u8f93\u51653\u4f4dUID", "", uid => {
        const key = normalizeUidKey(uid);
        if(key.length !== 3){
            popupInfo("\u8bf7\u8f93\u51653\u4f4dUID");
            return;
        }
        const list = getUidListByUid(key);
        // Show on next frame to avoid dialog transition conflicts with prompt hide().
        Core.app.post(() => {
            try{
                showUidDbMatchListDialog(key, list);
            }catch(e){
                Log.err(e);
                popupInfo("\u67e5\u8be2\u7a97\u53e3\u6253\u5f00\u5931\u8d25");
            }
        });
    });
}

function makeAsciiProgressBar(current, total, width){
    const w = Math.max(10, Number(width || 28));
    if(total <= 0) return "[" + new Array(w + 1).join("-") + "]";
    const ratio = Math.max(0, Math.min(1, current / total));
    const fill = Math.floor(ratio * w);
    let s = "[";
    for(let i = 0; i < w; i++) s += (i < fill ? "#" : "-");
    s += "]";
    return s;
}

function showUidBruteforceProgressDialog(){
    const dialog = new BaseDialog("UID\u7a77\u4e3e\u8fdb\u5ea6");
    dialog.closeOnBack();

    let covered = 0;
    let total = getAllUidTargets().targets.length;
    let checked = 0;

    dialog.cont.table(cons(t => {
        t.left();
        t.defaults().left().pad(6);
        t.label(() => {
            return "\u8fdb\u5ea6: " + covered + "/" + total + "\n" +
                makeAsciiProgressBar(covered, total, 32) + "\n" +
                "\u7a77\u4e3e\u6b21\u6570: " + checked + " (\u6bcf50\u4e07\u6b21\u66f4\u65b0\u4e00\u6b65)";
        }).color(Pal.lightishGray).left().wrap().width(720);
    })).growX().row();

    dialog.buttons.defaults().size(220, 54).pad(4);
    dialog.buttons.button("\u540e\u53f0\u8fd0\u884c", () => dialog.hide());

    dialog.show();

    buildUidDbAll8s(result => {
        try{ dialog.hide(); }catch(e){ }

        if(!result || !result.ok){
            popupInfo("UID\u6570\u636e\u5e93\u6784\u5efa\u5931\u8d25");
            return;
        }
        const m = result.meta;
        popupInfo("\u6784\u5efa\u5b8c\u6210\n\u77edUID\u8986\u76d6: " + m.foundCount + "/" + m.targetCount + "\n\u957fid\u603b\u6570: " + (m.longIdCount || 0));
    }, prog => {
        covered = Number(prog.covered || 0);
        total = Number(prog.total || total);
        checked = Number(prog.checked || checked);
    });
}

function showUidImportDialog(){
    const dialog = new BaseDialog("\u5bfc\u5165UID\u6570\u636e\u5e93");
    dialog.closeOnBack();

    dialog.cont.table(cons(t => {
        t.left();
        t.defaults().left().pad(6);
        t.add("\u652f\u6301\u4ece\u526a\u8d34\u677f\u6216\u6587\u4ef6\u5bfc\u5165\u6570\u636e\u5e93").color(Pal.accent);
    })).growX().row();

    dialog.buttons.defaults().height(54).pad(4);
    dialog.buttons.button("\u4ece\u526a\u8d34\u677f\u5bfc\u5165", () => {
        dialog.hide();
        const text = "" + (Core.app.getClipboardText() || "");
        const result = importUidDbText(text);
        if(!result.ok){
            popupInfo(result.message || "\u5bfc\u5165\u5931\u8d25");
            return;
        }
        popupInfo(summarizeImportResult(result));
    }).width(220);

    dialog.buttons.button("\u4ece\u6587\u4ef6\u5bfc\u5165", () => {
        dialog.hide();
        showPrompt("\u5bfc\u5165\u6587\u4ef6\u8def\u5f84", "\u8f93\u5165JSON/TXT\u6570\u636e\u5e93\u6587\u4ef6\u8def\u5f84", "", path => {
            const result = importUidDbFromFile(path);
            if(!result.ok){
                popupInfo(result.message || "\u5bfc\u5165\u5931\u8d25");
                return;
            }
            popupInfo(summarizeImportResult(result));
        });
    }).width(220);

    dialog.buttons.button("\u53d6\u6d88", () => dialog.hide()).width(150);
    dialog.show();
}

function showUidExportDialog(){
    showPrompt("\u5bfc\u51faUID\u6570\u636e\u5e93", "\u8f93\u5165\u5bfc\u51fa\u8def\u5f84(\u53ef\u7559\u7a7a\u4f7f\u7528\u9ed8\u8ba4)", "", path => {
        try{
            const outPath = exportUidDbToFile(path);
            Core.app.setClipboardText(outPath);
            popupInfo("\u5bfc\u51fa\u6210\u529f\n" + outPath + "\n\u8def\u5f84\u5df2\u590d\u5236");
        }catch(e){
            popupInfo("\u5bfc\u51fa\u5931\u8d25");
        }
    });
}

function ensureApprovedWithWarning(onApproved){
    if(isApproved()){
        if(typeof onApproved === "function") onApproved();
        return;
    }
    showUidGenerateConfirmDialog(onApproved);
}

function showUidGenerateConfirmDialog(onApproved){
    const dialog = new BaseDialog("UID Query Notice");
    dialog.closeOnBack();

    dialog.cont.table(cons(t => {
        t.center();
        t.defaults().center().pad(6);
        const warn = t.add(UID_GEN_WARNING).color(Pal.remove).center().wrap().width(760).get();
        warn.setAlignment(Align.center);
        warn.setFontScale(1.2);
    })).growX();

    dialog.buttons.defaults().pad(4).height(62);
    dialog.buttons.button("\u786e\u8ba4\u751f\u6210", () => {
        dialog.hide();
        showApprovalCodePrompt(code => {
            if(sanitizeIdText(code) !== getApprovalCode()){
                toast("[scarlet]\u5ba1\u6279\u7801\u9519\u8bef\uff0c\u5df2\u9000\u51fa[]");
                return;
            }
            setApproved(true);
            if(typeof onApproved === "function") onApproved();
        });
    }).width(240);

    dialog.buttons.button("\u5bf9\u4e0d\u8d77\uff0c\u6211\u662f\u826f\u6c11", () => dialog.hide()).width(260);
    dialog.show();
}

function showApprovalCodePrompt(onSubmit){
    const dialog = new BaseDialog("\u4f5c\u8005\u5ba1\u6279\u7801");
    dialog.closeOnBack();

    let field;
    dialog.cont.table(cons(t => {
        t.center();
        t.defaults().center().pad(6);

        const tip = t.add("\u8bf7\u8f93\u5165\u4f5c\u8005\u5ba1\u6279\u7801").center().wrap().width(700).get();
        tip.setAlignment(Align.center);
        tip.setFontScale(1.2);
        t.row();

        field = t.field("", () => {}).width(700).padTop(8).get();
        try{ field.setAlignment(Align.center); }catch(e){ }
        try{ field.setMessageText("\u5ba1\u6279\u7801"); }catch(e){ }
        try{ field.setFontScale(1.15); }catch(e){ }
    })).growX();

    dialog.buttons.defaults().size(220, 62).pad(4);
    dialog.buttons.button("\u786e\u5b9a", () => {
        try{ onSubmit(field.getText()); }catch(e){ Log.err(e); }
        dialog.hide();
    });
    dialog.buttons.button("\u53d6\u6d88", () => dialog.hide());

    dialog.show();
    Core.scene.setKeyboardFocus(field);
}

function computeUidBytesFromUuidBytes(uuidBytes){
    // Mindustry protocol: client sends 8 uuid bytes + 8-byte long(CRC32(uuidBytes)).
    // Server reads 16 bytes and Base64-encodes them as the player "uuid".
    // We call that 16-byte Base64 string "UID" here.
    if(uuidBytes == null || uuidBytes.length !== 8) return null;

    const out = ReflectArray.newInstance(Packages.java.lang.Byte.TYPE, 16);
    for(let i = 0; i < 8; i++) out[i] = uuidBytes[i];

    const crc = new CRC32();
    crc.update(uuidBytes, 0, 8);
    let v = Number(crc.getValue());
    v = (v >>> 0);

    // writeLong(big-endian): 0,0,0,0, (crc >>> 24), (crc >>> 16), (crc >>> 8), crc
    out[8] = 0;
    out[9] = 0;
    out[10] = 0;
    out[11] = 0;
    out[12] = toSignedByte((v >>> 24) & 0xff);
    out[13] = toSignedByte((v >>> 16) & 0xff);
    out[14] = toSignedByte((v >>> 8) & 0xff);
    out[15] = toSignedByte(v & 0xff);
    return out;
}

function normalizeUuidOrUid(inputText){
    const raw = sanitizeIdText(inputText);
    if(raw.length === 0){
        return {valid: false, error: "empty"};
    }

    // Try decode as-is, then with padding.
    let bytes = b64Decode(raw);
    if(bytes == null && raw.length % 4 !== 0){
        bytes = b64Decode(padBase64(raw));
    }
    if(bytes == null){
        return {valid: false, error: "base64"};
    }

    if(bytes.length === 8){
        const uidBytes = computeUidBytesFromUuidBytes(bytes);
        if(uidBytes == null) return {valid: false, error: "uid"};
        const uid16 = b64Encode(uidBytes);
        return {
            valid: true,
            kind: "uuid8",
            uuid8: b64Encode(bytes),
            uid16: uid16,
            uid3: shortStrFromUid16(uid16)
        };
    }

    if(bytes.length === 16){
        // Treat as UID; extract the first 8 bytes.
        const uuidBytes = ReflectArray.newInstance(Packages.java.lang.Byte.TYPE, 8);
        for(let i = 0; i < 8; i++) uuidBytes[i] = bytes[i];
        const uidBytes = computeUidBytesFromUuidBytes(uuidBytes);
        const uuid8 = b64Encode(uuidBytes);
        const uid16 = uidBytes != null ? b64Encode(uidBytes) : "";

        // Optional integrity check: the provided UID should match the recomputed one.
        const matches = (uid16.length > 0 && uid16 === b64Encode(bytes));
        return {
            valid: true,
            kind: "uid16",
            uuid8: uuid8,
            uid16: uid16,
            uid3: shortStrFromUid16(uid16),
            uidMatches: matches
        };
    }

    return {valid: false, error: "length"};
}

function getCurrentUuid8(){
    // Ensure something exists.
    let s = Core.settings.getString("uuid", "");
    if(s == null || ("" + s).length === 0){
        try{
            s = Vars.platform.getUUID();
        }catch(e){
            s = "";
        }
    }

    const norm = normalizeUuidOrUid(s);
    if(norm.valid) return norm.uuid8;
    return sanitizeIdText(s);
}

function setCurrentUuid8(uuid8){
    Core.settings.put("uuid", "" + uuid8);
    saveSettingsCompat();
}

function getUid16ForUuid8(uuid8){
    const norm = normalizeUuidOrUid(uuid8);
    if(!norm.valid) return "";
    return norm.uid16;
}

function getUidShortForUuid8(uuid8){
    const norm = normalizeUuidOrUid(uuid8);
    if(!norm.valid) return "";
    return norm.uid3 || "";
}

function getUidSha1ForUuid8(uuid8){
    const s = sanitizeIdText(uuid8);
    if(s.length === 0) return "";
    return sha1Hex(s);
}

function serverKey(ip, port){
    return ("" + ip).trim().toLowerCase() + ":" + port;
}

function normalizeServerKeyInput(text){
    // Canonicalize to the same format used by ClientServerConnectEvent: ip:port.
    // Default port is 6567 if omitted.
    let s = sanitizeIdText(text).toLowerCase();
    if(s.length === 0) return "";

    // Strip common prefixes (users may paste from links).
    s = s.replace(/^mindustry:\/\/connect\//, "");
    s = s.replace(/^https?:\/\//, "");

    if(s.indexOf(":") === -1){
        return s + ":6567";
    }

    if(s.endsWith(":")){
        return s + "6567";
    }

    return s;
}

function findRuleForServer(state, ip, port){
    const key = serverKey(ip, port);
    for(let i = 0; i < state.serverRules.length; i++){
        const r = state.serverRules[i];
        if(!r || typeof r !== "object") continue;
        if(("" + (r.server || "")).trim().toLowerCase() === key){
            return r;
        }
    }
    return null;
}

function showPrompt(title, message, initial, onOk){
    // Basic 1-line input dialog.
    const dialog = new BaseDialog(title);

    let field;
    dialog.cont.table(cons(t => {
        t.left();
        if(message && ("" + message).length > 0){
            t.add(message).left().wrap().width(560);
            t.row();
        }
        field = t.field(initial || "", () => {}).growX().padTop(8).get();
    })).growX();

    dialog.buttons.button("@ok", () => {
        try{ onOk(field.getText()); }catch(e){ Log.err(e); }
        dialog.hide();
    }).size(160, 54);
    dialog.buttons.button("@cancel", () => dialog.hide()).size(160, 54);
    dialog.closeOnBack();
    dialog.show();
    Core.scene.setKeyboardFocus(field);
}

function rebuildSavedList(container, state, options){
    container.clear();
    container.top().left();
    container.defaults().growX().left();

    if(state.saved.length === 0){
        container.add("@uuidmanager.saved.empty").color(Pal.gray);
        return;
    }

    for(let i = 0; i < state.saved.length; i++){
        const entry = state.saved[i];
        if(!entry || typeof entry !== "object") continue;
        const note = ("" + (entry.note || "")).trim();
        const uuid8 = sanitizeIdText(entry.uuid8 || "");
        const uid = getUidShortForUuid8(uuid8);
        const sha1 = getUidSha1ForUuid8(uuid8);

        container.table(cons(row => {
            row.setColor(Pal.gray);
            row.left();
            row.defaults().pad(4).left();

            const actionText = options && options.pickOnly ? "@uuidmanager.saved.pick" : "@uuidmanager.saved.use";

            row.button(actionText, Styles.cleart, () => {
                if(options && typeof options.onPick === "function"){
                    options.onPick(uuid8, entry);
                }
                if(!(options && options.pickOnly)){
                    setCurrentUuid8(uuid8);
                }
                if(options && options.close) options.close();
            }).width(96).height(44);

             row.table(cons(info => {
                  info.left();
                  info.defaults().left();
                  info.add((note.length > 0 ? note : "(no note)")).color(Pal.accent).row();
                 info.add(tr("uuidmanager.saved.uuid") + ": " + uuid8).color(Pal.lightishGray).row();
                 info.add(tr("uuidmanager.saved.uid") + ": " + uid).color(Pal.lightishGray).row();
                 info.add(tr("uuidmanager.saved.sha1") + ": " + sha1).color(Pal.lightishGray);
              })).growX();

            row.button(Icon.pencilSmall, Styles.cleari, () => {
                showPrompt("@uuidmanager.saved.edit", "@uuidmanager.saved.note", note, newNote => {
                    entry.note = ("" + newNote).trim();
                    saveState(state);
                    if(options && options.rebuild) options.rebuild();
                });
            }).size(44);

            row.button(Icon.trashSmall, Styles.cleari, () => {
                Vars.ui.showConfirm("@confirm", "@uuidmanager.saved.delete", () => {
                    state.saved.splice(i, 1);
                    saveState(state);
                    if(options && options.rebuild) options.rebuild();
                });
            }).size(44);
        })).padBottom(6).growX();
        container.row();
    }
}

function showSavedUuidsDialog(options){
    const state = loadState();
    const dialog = new BaseDialog("@uuidmanager.saved.title");
    dialog.addCloseButton();
    dialog.closeOnBack();

    const listTable = new Packages.arc.scene.ui.layout.Table();

    const rebuild = () => {
        rebuildSavedList(listTable, state, {
            pickOnly: options && options.pickOnly,
            onPick: options && options.onPick,
            close: () => dialog.hide(),
            rebuild: rebuild
        });
    };

    dialog.cont.table(cons(top => {
        top.left();
        top.defaults().pad(6).left();
        const uuid8 = getCurrentUuid8();
        const uid = getUidShortForUuid8(uuid8);
        const sha1 = getUidSha1ForUuid8(uuid8);
        top.add(tr("uuidmanager.saved.uuid") + ": " + uuid8).color(Pal.lightishGray).row();
        top.add(tr("uuidmanager.saved.uid") + ": " + uid).color(Pal.lightishGray).row();
        top.add(tr("uuidmanager.saved.sha1") + ": " + sha1).color(Pal.lightishGray);
    })).growX().padBottom(10).row();

    dialog.cont.pane(cons(p => {
        p.add(listTable).growX();
    })).grow().row();

    dialog.buttons.defaults().size(200, 54).pad(4);
    dialog.buttons.button("@uuidmanager.saved.addCurrent", () => {
        const uuid8 = getCurrentUuid8();
        showPrompt("@uuidmanager.saved.add", "@uuidmanager.saved.note", "", note => {
            state.saved.push({note: ("" + note).trim(), uuid8: uuid8});
            saveState(state);
            rebuild();
        });
    });

    rebuild();
    dialog.show();
}

function showRuleEditor(state, existingRule, onDone){
    const dialog = new BaseDialog(existingRule ? "@uuidmanager.server.edit" : "@uuidmanager.server.add");
    dialog.closeOnBack();

    let serverField, noteField, uuidField, uidLabel, sha1Label, statusLabel;
    let suppress = false;

    const updateDerived = () => {
        const norm = normalizeUuidOrUid(uuidField.getText());
        if(norm.valid){
            uidLabel.setText(norm.uid3 || "");
            sha1Label.setText(getUidSha1ForUuid8(norm.uuid8));
            statusLabel.setText("");
            statusLabel.setColor(Pal.lightishGray);
        }else{
            uidLabel.setText("");
            sha1Label.setText("");
            statusLabel.setText("@uuidmanager.join.invalid");
            statusLabel.setColor(Pal.remove);
        }
    };

    dialog.cont.table(cons(t => {
        t.left();
        t.defaults().pad(6).left();

        t.add("@uuidmanager.server.server").width(120);
        serverField = t.field(existingRule ? (existingRule.server || "") : "", () => {}).growX().get();
        t.row();

        t.add("@uuidmanager.server.note").width(120);
        noteField = t.field(existingRule ? (existingRule.note || "") : "", () => {}).growX().get();
        t.row();

        t.add("@uuidmanager.server.uuid").width(120);
        uuidField = t.field(existingRule ? (existingRule.uuid8 || "") : getCurrentUuid8(), text => {
            if(suppress) return;
            const norm = normalizeUuidOrUid(text);
            if(norm.valid && norm.kind === "uid16"){
                suppress = true;
                uuidField.setText(norm.uuid8);
                suppress = false;
            }
            updateDerived();
        }).growX().get();

        t.button("@uuidmanager.server.chooseSaved", Styles.cleart, () => {
            showSavedUuidsDialog({
                pickOnly: true,
                onPick: (uuid8) => {
                    suppress = true;
                    uuidField.setText(uuid8);
                    suppress = false;
                    updateDerived();
                }
            });
        }).width(120).height(54);

        t.row();
        t.add("@uuidmanager.join.uid").width(120);
        uidLabel = t.add("").color(Pal.lightishGray).left().growX().get();

        t.row();
        t.add("@uuidmanager.server.sha1").width(120);
        sha1Label = t.add("").color(Pal.lightishGray).left().growX().get();

        t.row();
        statusLabel = t.add("").left().colspan(3).get();
    })).width(680);

    dialog.buttons.defaults().size(200, 54).pad(4);
    dialog.buttons.button("@uuidmanager.server.save", () => {
        const key = normalizeServerKeyInput(serverField.getText());
        if(key.length === 0){
            toast("[scarlet]Server is empty[]");
            return;
        }

        const norm = normalizeUuidOrUid(uuidField.getText());
        if(!norm.valid){
            toast("[scarlet]Invalid UUID/UID[]");
            return;
        }

        const rule = existingRule || {};
        rule.server = key;
        rule.note = ("" + noteField.getText()).trim();
        rule.uuid8 = norm.uuid8;

        if(!existingRule){
            state.serverRules.push(rule);
        }
        saveState(state);
        dialog.hide();
        if(onDone) onDone();
    });
    dialog.buttons.button("@uuidmanager.server.cancel", () => dialog.hide());

    dialog.show();
    updateDerived();
}

function rebuildRulesList(container, state, rebuild){
    container.clear();
    container.top().left();
    container.defaults().growX().left();

    if(state.serverRules.length === 0){
        container.add("@uuidmanager.server.empty").color(Pal.gray);
        return;
    }

    for(let i = 0; i < state.serverRules.length; i++){
        const rule = state.serverRules[i];
        if(!rule || typeof rule !== "object") continue;
        const note = ("" + (rule.note || "")).trim();
        const server = ("" + (rule.server || "")).trim();
        const uuid8 = sanitizeIdText(rule.uuid8 || "");
        const uid = getUidShortForUuid8(uuid8);
        const sha1 = getUidSha1ForUuid8(uuid8);

        container.table(cons(row => {
            row.setColor(Pal.gray);
            row.left();
            row.defaults().pad(4).left();

             row.table(cons(info => {
                 info.left();
                 info.add((note.length > 0 ? note : server)).color(Pal.accent).row();
                 info.add(server).color(Pal.lightishGray).row();
                 info.add(tr("uuidmanager.join.uuid") + ": " + uuid8).color(Pal.lightishGray).row();
                 info.add(tr("uuidmanager.join.uid") + ": " + uid).color(Pal.lightishGray).row();
                 info.add(tr("uuidmanager.server.sha1") + ": " + sha1).color(Pal.lightishGray);
             })).growX();

            row.button(Icon.pencilSmall, Styles.cleari, () => {
                showRuleEditor(state, rule, rebuild);
            }).size(44);

            row.button(Icon.trashSmall, Styles.cleari, () => {
                Vars.ui.showConfirm("@confirm", "@uuidmanager.server.delete", () => {
                    state.serverRules.splice(i, 1);
                    saveState(state);
                    rebuild();
                });
            }).size(44);
        })).padBottom(6).growX();
        container.row();
    }
}

function showServerRulesDialog(){
    const state = loadState();
    const dialog = new BaseDialog("@uuidmanager.server.title");
    dialog.addCloseButton();
    dialog.closeOnBack();

    const listTable = new Packages.arc.scene.ui.layout.Table();

    const rebuild = () => {
        rebuildRulesList(listTable, state, rebuild);
    };

    dialog.cont.table(cons(top => {
        top.left();
        const checkbox = new Packages.arc.scene.ui.CheckBox("@uuidmanager.settings.autoSwitch");
        checkbox.setChecked(!!state.autoSwitch);
        checkbox.changed(() => {
            state.autoSwitch = checkbox.isChecked();
            saveState(state);
        });
        top.add(checkbox).left();
    })).growX().padBottom(10).row();

    dialog.cont.pane(cons(p => {
        p.add(listTable).growX();
    })).grow().row();

    dialog.buttons.defaults().size(200, 54).pad(4);
    dialog.buttons.button("@uuidmanager.server.add", () => {
        showRuleEditor(state, null, rebuild);
    });

    rebuild();
    dialog.show();
}

function injectJoinDialogRow(){
    if(Vars.ui == null || Vars.ui.join == null) return;
    const join = Vars.ui.join;
    if(!join.isShown()) return;

    const cont = join.cont;
    if(cont == null) return;
    const children = cont.getChildren();
    if(children == null || children.size === 0) return;

    const nameTable = children.get(0);
    if(nameTable == null) return;

    // Avoid duplicates.
    const ntChildren = nameTable.getChildren();
    for(let i = 0; i < ntChildren.size; i++){
        const e = ntChildren.get(i);
        if(e != null && ("" + e.name) === JOIN_ROW_NAME) return;
    }

    // Increase fixed height set by JoinDialog.setup().
    try{
        const cell = cont.getCell(nameTable);
        if(cell != null) cell.height(340);
    }catch(e){
        // ignore
    }

    let uuidField, uidValueLabel, sha1ValueLabel, statusLabel;
    let suppress = false;

    const applyNorm = (norm) => {
        if(norm && norm.valid){
            uidValueLabel.setText(norm.uid3 || "");
            sha1ValueLabel.setText(getUidSha1ForUuid8(norm.uuid8));
            statusLabel.setText("");
            statusLabel.setColor(Pal.lightishGray);
        }else{
            uidValueLabel.setText("");
            sha1ValueLabel.setText("");
            statusLabel.setText("@uuidmanager.join.invalid");
            statusLabel.setColor(Pal.remove);
        }
    };

    const setFromText = (text, fromUser) => {
        const norm = normalizeUuidOrUid(text);
        if(norm.valid){
            // Always store the canonical 8-byte UUID.
            setCurrentUuid8(norm.uuid8);
            if(fromUser && norm.kind === "uid16"){
                suppress = true;
                uuidField.setText(norm.uuid8);
                suppress = false;
            }
        }
        applyNorm(norm);
    };

    // Add vertical space so the injected UUID block stays below the name row.
    nameTable.row();
    nameTable.add().height(20).colspan(3);
    nameTable.row();
    nameTable.table(cons(t => {
        t.name = JOIN_ROW_NAME;
        t.left();
        t.defaults().pad(4).left();

        t.add("@uuidmanager.join.uuid").padRight(10).width(80);
        uuidField = t.field(getCurrentUuid8(), text => {
            if(suppress) return;
            setFromText(text, true);
        }).growX().pad(6).get();
        uuidField.setMessageText("Base64");
        uuidField.setMaxLength(64);

        t.button(Icon.bookSmall, Styles.cleari, () => {
            showSavedUuidsDialog({
                pickOnly: false,
                onPick: (uuid8) => {
                    suppress = true;
                    uuidField.setText(uuid8);
                    suppress = false;
                    setFromText(uuid8, false);
                }
            });
        }).size(54);

        t.row();
        t.add("@uuidmanager.join.uid").padRight(10).width(80);
        uidValueLabel = t.add("").color(Pal.lightishGray).left().growX().get();
        t.button(Icon.copySmall, Styles.cleari, () => {
            const text = "" + uidValueLabel.getText();
            if(text.length > 0){
                Core.app.setClipboardText(text);
                toast("Copied");
            }
        }).size(54);

        t.row();
        t.add("@uuidmanager.join.uidsha1").padRight(10).width(80);
        sha1ValueLabel = t.add("").color(Pal.lightishGray).left().growX().get();
        t.button(Icon.copySmall, Styles.cleari, () => {
            const text = "" + sha1ValueLabel.getText();
            if(text.length > 0){
                Core.app.setClipboardText(text);
                toast("Copied");
            }
        }).size(54);

        t.row();
        t.add("UID").padRight(10).width(80);
        const targetUidField = t.field("", () => {}).growX().pad(6).get();
        targetUidField.setMessageText("uid3");
        targetUidField.setMaxLength(24);

        const queryButton = t.button("\u67e5\u8be2", Styles.cleart, () => {
            const target = sanitizeIdText(targetUidField.getText());
            if(target.length !== 3){
                statusLabel.setText("[scarlet]\u8bf7\u8f93\u51653\u4f4dUID[]");
                statusLabel.setColor(Pal.remove);
                return;
            }

            ensureApprovedWithWarning(() => {
                queryButton.setDisabled(true);
                try{
                    const list = getUidListByUid(target);
                    if(list.length === 0){
                        statusLabel.setText("[scarlet]\u6570\u636e\u5e93\u672a\u547d\u4e2d\uff0c\u8bf7\u5148\u5728\u8bbe\u7f6e\u91cc\u7a77\u4e3e[]");
                        statusLabel.setColor(Pal.remove);
                        return;
                    }

                    const uuid8 = "" + list[0];

                    Core.app.setClipboardText(uuid8);

                    // Apply found UUID directly to current field/settings.
                    suppress = true;
                    uuidField.setText(uuid8);
                    suppress = false;
                    setFromText(uuid8, false);

                    statusLabel.setText("[accent]\u6570\u636e\u5e93\u547d\u4e2d(" + list.length + ")\u5e76\u590d\u5236: " + uuid8 + "[]");
                    statusLabel.setColor(Pal.accent);
                    toast("\u5df2\u4eceUID\u6570\u636e\u5e93\u590d\u5236UUID");
                }finally{
                    queryButton.setDisabled(false);
                }
            });
        }).width(110).height(54).get();

        t.row();
        statusLabel = t.add("").left().colspan(3).get();

        // Keep derived labels fresh while editing; do not force-sync text every frame,
        // otherwise some IME/focus paths may overwrite user input.
        t.update(() => {
            applyNorm(normalizeUuidOrUid(uuidField.getText()));
        });
    })).colspan(3).growX().padTop(20);

    cont.invalidateHierarchy();
}

function addSettingsCategory(){
    if(Vars.ui == null || Vars.ui.settings == null) return;
    Vars.ui.settings.addCategory(tr("uuidmanager.category"), Icon.settingsSmall, table => {
        const state = loadState();

        table.defaults().padTop(6).left();

        table.add("@uuidmanager.settings.current").color(Pal.accent).row();
        table.label(() => {
            const uuid8 = getCurrentUuid8();
            const uid = getUidShortForUuid8(uuid8);
            const sha1 = getUidSha1ForUuid8(uuid8);
            return tr("uuidmanager.join.uuid") + ": " + uuid8 + "\n" + tr("uuidmanager.join.uid") + ": " + uid + "\n" + tr("uuidmanager.join.uidsha1") + ": " + sha1;
        }).color(Pal.lightishGray).left().wrap().width(680).row();

        table.add("GitHub \u66f4\u65b0").color(Pal.accent).padTop(10).row();
        table.label(() => getUpdateStatusText()).color(Pal.lightishGray).left().wrap().width(680).row();
        table.button("\u68c0\u67e5\u66f4\u65b0", Icon.bookSmall, Styles.cleart, () => {
            checkGithubUpdate(true);
        }).height(54).growX().row();

        const checkbox = new Packages.arc.scene.ui.CheckBox("@uuidmanager.settings.autoSwitch");
        checkbox.setChecked(!!state.autoSwitch);
        checkbox.changed(() => {
            const st = loadState();
            st.autoSwitch = checkbox.isChecked();
            saveState(st);
        });
        table.add(checkbox).left().row();

        table.button("@uuidmanager.settings.manageSaved", Icon.bookSmall, Styles.cleart, () => showSavedUuidsDialog(null))
            .height(54).growX().padTop(10).row();
        table.button("@uuidmanager.settings.manageServers", Icon.hostSmall, Styles.cleart, () => showServerRulesDialog())
            .height(54).growX().row();

        table.add("UID\u6570\u636e\u5e93").color(Pal.accent).padTop(12).row();
        table.label(() => {
            return getUidDbMetaText();
        }).color(Pal.lightishGray).left().wrap().width(680).row();

        table.button("\u7a77\u4e3e\u6240\u67093\u4f4dUID(8\u79d2)", Icon.bookSmall, Styles.cleart, () => {
            ensureApprovedWithWarning(() => {
                showUidBruteforceProgressDialog();
            });
        }).height(54).growX().row();

        table.button("\u5bfc\u5165UID\u6570\u636e\u5e93", Icon.copySmall, Styles.cleart, () => {
            showUidImportDialog();
        }).height(54).growX().row();

        table.button("\u5bfc\u51faUID\u6570\u636e\u5e93", Icon.bookSmall, Styles.cleart, () => {
            showUidExportDialog();
        }).height(54).growX().row();

        table.button("\u67e5\u8be2UID\u6570\u636e\u5e93", Icon.copySmall, Styles.cleart, () => showUidDbLookupDialog())
            .height(54).growX().row();
    });
}

// Auto-switch UUID before connecting.
Events.on(ClientServerConnectEvent, e => {
    const state = loadState();
    if(!state.autoSwitch) return;
    const rule = findRuleForServer(state, e.ip, e.port);
    if(rule == null) return;

    const norm = normalizeUuidOrUid(rule.uuid8 || "");
    if(!norm.valid){
        toast(tr("uuidmanager.toast.invalidRule").replace("{0}", "" + rule.server));
        return;
    }

    setCurrentUuid8(norm.uuid8);
    toast(tr("uuidmanager.toast.switched").replace("{0}", serverKey(e.ip, e.port)));
});

Events.on(ClientLoadEvent, () => {
    try{
        // Ensure UUID exists early.
        getCurrentUuid8();
    }catch(e){
        Log.err(e);
    }

    // Join dialog rebuilds its UI often; re-inject our row when shown.
    // Register this first so the join UI still works even if settings injection fails.
    let injectErrorLogged = false;
    try{
        Events.run(Trigger.update, () => {
            try{
                injectJoinDialogRow();
            }catch(e){
                // Log only once; join UI structure can vary between builds.
                if(!injectErrorLogged){
                    injectErrorLogged = true;
                    Log.err("[uuidmanager] Failed to inject Join dialog row.");
                    Log.err(e);
                }
            }
        });
    }catch(e){
        Log.err("[uuidmanager] Failed to register update hook.");
        Log.err(e);
    }

    // Settings UI can be created slightly later depending on the platform/build.
    Core.app.post(() => {
        try{
            addSettingsCategory();
        }catch(e){
            Log.err("[uuidmanager] Failed to add settings category.");
            Log.err(e);
        }
    });

    // Auto-check new GitHub release (throttled by interval).
    Core.app.post(() => {
        try{
            checkGithubUpdate(false);
        }catch(e){
            Log.err("[uuidmanager] Auto update check failed.");
            Log.err(e);
        }
    });

    Log.info("[uuidmanager] Loaded.");
});
