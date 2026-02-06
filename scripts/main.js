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
    const total = Number(m.targetCount || 0);
    const timeout = Number(m.excludedTimeoutCount || 0);
    const cores = Number(m.cores || 0);
    const checked = Number(m.checked || 0);
    return "\u6570\u636e\u6761\u76ee: " + found + "/" + total + "  |  \u8d85\u65f6\u6392\u9664: " + timeout + "\n" +
        "\u4e0a\u6b21\u6784\u5efa\u6838\u5fc3\u6570: " + cores + "  |  \u5c1d\u8bd5\u6b21\u6570: " + checked;
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

    // Ensure values are plain strings and keys are 3-char IDs.
    const clean = {};
    for(var k in db.map){
        if(!Object.prototype.hasOwnProperty.call(db.map, k)) continue;
        const key = sanitizeIdText(k);
        if(key.length !== 3) continue;
        const val = sanitizeIdText(db.map[k]);
        if(val.length === 0) continue;
        clean[key] = val;
    }
    db.map = clean;

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
    const key = sanitizeIdText(uid3);
    if(key.length !== 3) return "";
    const db = loadUidDb();
    return sanitizeIdText(db.map[key] || "");
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

function buildUidDbAll8s(onDone){
    if(_uidBuildRunning){
        toast("[accent]UID\u6570\u636e\u5e93\u6784\u5efa\u4e2d...[]");
        return;
    }

    _uidBuildRunning = true;
    const runMillis = 8000;
    const cores = Math.max(1, Number(Runtime.getRuntime().availableProcessors()));
    const deadline = Number(System.currentTimeMillis()) + runMillis;
    const checked = new AtomicLong(0);
    const finished = new AtomicInteger(0);
    const foundMap = new ConcurrentHashMap();

    for(let wid = 0; wid < cores; wid++){
        const workerId = wid;
        const worker = new Runnable({
            run: function(){
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
                            foundMap.putIfAbsent(sid, b64Encode(uuidBytes));
                        }
                        checked.incrementAndGet();
                    }
                }catch(e){
                    // ignore single worker failure
                }finally{
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
            while(finished.get() < cores){
                try{ Packages.java.lang.Thread.sleep(50); }catch(e){ }
            }

            Core.app.post(() => {
                try{
                    const db = loadUidDb();
                    const iter = foundMap.entrySet().iterator();
                    while(iter.hasNext()){
                        const e = iter.next();
                        const k = "" + e.getKey();
                        const v = "" + e.getValue();
                        if(!(k in db.map)) db.map[k] = v;
                    }

                    const targetInfo = getAllUidTargets();
                    const targets = targetInfo.targets;
                    let foundCount = 0;
                    for(let i = 0; i < targets.length; i++){
                        if(db.map[targets[i]]) foundCount++;
                    }

                    db.meta = {
                        targetCount: targets.length,
                        foundCount: foundCount,
                        excludedSpecialCount: targetInfo.excludedSpecial,
                        excludedTimeoutCount: Math.max(0, targets.length - foundCount),
                        checked: Number(checked.get()),
                        cores: cores,
                        lastBuildAt: Number(System.currentTimeMillis()),
                        lastBuildSec: 8
                    };

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

function showUidDbLookupDialog(){
    showPrompt("UID\u6570\u636e\u5e93\u67e5\u8be2", "\u8f93\u51653\u4f4dUID", "", uid => {
        const key = sanitizeIdText(uid);
        if(key.length !== 3){
            popupInfo("\u8bf7\u8f93\u51653\u4f4dUID");
            return;
        }
        const uuid8 = lookupUuid8ByUid(key);
        if(uuid8.length === 0){
            popupInfo("\u6570\u636e\u5e93\u672a\u547d\u4e2d: " + key);
            return;
        }

        Core.app.setClipboardText(uuid8);
        popupInfo("\u60a8\u5df2\u590d\u5236");
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

        container.table(Tex.whiteui, row => {
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
        }).padBottom(6).growX();
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

        container.table(Tex.whiteui, row => {
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
        }).padBottom(6).growX();
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
                    const uuid8 = lookupUuid8ByUid(target);
                    if(uuid8.length === 0){
                        statusLabel.setText("[scarlet]\u6570\u636e\u5e93\u672a\u547d\u4e2d\uff0c\u8bf7\u5148\u5728\u8bbe\u7f6e\u91cc\u7a77\u4e3e[]");
                        statusLabel.setColor(Pal.remove);
                        return;
                    }

                    Core.app.setClipboardText(uuid8);

                    // Apply found UUID directly to current field/settings.
                    suppress = true;
                    uuidField.setText(uuid8);
                    suppress = false;
                    setFromText(uuid8, false);

                    statusLabel.setText("[accent]\u6570\u636e\u5e93\u547d\u4e2d\u5e76\u590d\u5236: " + uuid8 + "[]");
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
                buildUidDbAll8s(result => {
                    if(!result || !result.ok){
                        toast("[scarlet]UID\u6570\u636e\u5e93\u6784\u5efa\u5931\u8d25[]");
                        return;
                    }
                    const m = result.meta;
                    toast("[accent]\u6784\u5efa\u5b8c\u6210: " + m.foundCount + "/" + m.targetCount + "[]");
                });
                toast("[accent]\u5df2\u542f\u52a8UID\u6570\u636e\u5e93\u7a77\u4e3e(8\u79d2)...[]");
            });
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

    Log.info("[uuidmanager] Loaded.");
});
