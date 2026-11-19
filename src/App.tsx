import { useState, useEffect } from 'react';
import { initializeApp } from "firebase/app";
import {
    getFirestore, collection, getDocs, getDoc, doc, query, orderBy, where, limit, Timestamp
} from "firebase/firestore";
import {
    getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged
} from "firebase/auth";
import {
    BarChart3, ShieldAlert, FileDown, Search, Filter,
    ArrowRightLeft, AlertTriangle, PackageOpen,
    LogIn, LogOut, User, ClipboardCheck, CheckCircle2
} from 'lucide-react';

// --- FIREBASE CONFIGURATION (Same as Bunker) ---
const firebaseConfig = {
    apiKey: "AIzaSyCbGzXnim-FxhC3XmkjnbyTSaHxUaWciFQ",
    authDomain: "bunker-fd56e.firebaseapp.com",
    projectId: "bunker-fd56e",
    storageBucket: "bunker-fd56e.firebasestorage.app",
    messagingSenderId: "356419199566",
    appId: "1:356419199566:web:fa8e8f2e4d94556c45991f",
    measurementId: "G-CHM4R2HEM7"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// --- TYPES ---
export type TabType = 'SERIAL' | 'ROUTINE' | 'DERIVED';
export type ActionType = 'ISSUE' | 'RETURN' | 'USAGE' | 'STORE' | 'RELEASE' | 'RECEIVE_SUPPLY' | 'RETURN_SUPPLY' | 'TRANSFER';

interface CatalogItem { id: string; sku?: string; internalCode?: string; name: string; family?: string; type?: string; section?: string; }
interface InventoryRecord { sku: string; unitId: string; onHand: number; inStorage: number; }
interface SerializedItem { sku: string; serialNumber: string; owner: string; location: string; status: 'active' | 'used' | 'defect'; }

// --- CONSTANTS (must match the Bunker app) ---
const LINE_BUNKER = 'בונקר קווי';
const BUNKERS = ['בונקר עין זיתים', 'בונקר אביבים', LINE_BUNKER];
const COMPANIES = ['א', 'ב', 'ג', 'מסייעת', 'פלתצ', 'פלסמ'];
const INITIAL_UNITS = [...BUNKERS, ...COMPANIES];
// Column order of the stock table (same as Bunker): אביבים, companies, line bunker | total | עין זיתים
const UNITS_BEFORE_TOTAL = ['בונקר אביבים', ...COMPANIES, LINE_BUNKER];
const UNITS_AFTER_TOTAL = ['בונקר עין זיתים'];
const TABLE_UNITS = [...UNITS_BEFORE_TOTAL, ...UNITS_AFTER_TOTAL];
const DEFAULT_BUNKER = 'בונקר אביבים';
const SUPPLIER_UNIT = 'חטיבה';

const ACTION_LABELS: Record<ActionType, string> = {
    ISSUE: 'ניפוק', RETURN: 'החזרה', USAGE: 'דיווח שצ"ל', STORE: 'הפקדה באפסון', RELEASE: 'שחרור מאפסון',
    RECEIVE_SUPPLY: 'קליטה מספק', RETURN_SUPPLY: 'החזרה לספק', TRANSFER: 'העברה בין בונקרים'
};
const actionLabel = (t: string) => ACTION_LABELS[t as ActionType] || t;
const STATUS_LABELS: Record<string, string> = { active: 'פעיל', used: 'נוצל (שצ"ל)', defect: 'פגום' };

const hasRealSku = (s?: string) => { const t = (s ?? '').trim(); return t !== '' && t !== '0' && t !== '#N/A'; };
const itemCode = (i?: { sku?: string; internalCode?: string }) => !i ? '' : (hasRealSku(i.sku) ? (i.sku as string).trim() : (i.internalCode || ''));
const invKey = (sku: string, unit: string) => `${sku}_${unit}`;

const fmtDateTime = (ts: any) => ts?.seconds ? new Date(ts.seconds * 1000).toLocaleString('he-IL') : 'אין תאריך';
const fmtDate = (ts: any) => ts?.seconds ? new Date(ts.seconds * 1000).toLocaleDateString('he-IL') : 'אין תאריך';

// Where did the stock/serial move in a receipt: "from -> to"
const describeMove = (r: any): { from: string; to: string } => {
    const B = r.bunker || DEFAULT_BUNKER; const U = r.unit || '';
    switch (r.type) {
        case 'ISSUE': return { from: B, to: U };
        case 'RETURN': return { from: U, to: B };
        case 'RECEIVE_SUPPLY': return { from: SUPPLIER_UNIT, to: B };
        case 'RETURN_SUPPLY': return { from: B, to: SUPPLIER_UNIT };
        case 'USAGE': return { from: U, to: 'שצ"ל (נוצל)' };
        case 'STORE': return { from: U, to: `${B} (אפסון של ${U})` };
        case 'RELEASE': return { from: `${B} (אפסון של ${U})`, to: U };
        case 'TRANSFER': return { from: B, to: r.toBunker || U };
        default: return { from: '', to: '' };
    }
};

// What the serialized_items doc should look like right after this receipt
const expectedAfter = (r: any): { owner?: string; location?: string; status?: string } => {
    const B = r.bunker || DEFAULT_BUNKER; const U = r.unit;
    switch (r.type) {
        case 'ISSUE': case 'TRANSFER': return { owner: U, location: U, status: 'active' };
        case 'RETURN': case 'RECEIVE_SUPPLY': return { owner: B, location: B, status: 'active' };
        case 'RETURN_SUPPLY': return { owner: SUPPLIER_UNIT, location: SUPPLIER_UNIT };
        case 'USAGE': return { status: 'used' };
        case 'STORE': return { owner: U, location: B };
        case 'RELEASE': return { owner: U, location: U };
        default: return {};
    }
};

export default function BunkerDataApp() {
    const [user, setUser] = useState<any>(null);
    const [isAdmin, setIsAdmin] = useState<boolean | null>(null); // null = still checking
    const [activeTab, setActiveTab] = useState<TabType>('SERIAL');
    const [loading, setLoading] = useState(false);

    // Data
    const [catalog, setCatalog] = useState<CatalogItem[]>([]);
    const [receipts, setReceipts] = useState<any[]>([]);
    const [inventory, setInventory] = useState<InventoryRecord[] | null>(null);
    const [usageReceipts, setUsageReceipts] = useState<any[] | null>(null);

    // Routine tab filters
    const [selectedUnits, setSelectedUnits] = useState<string[]>([]);
    const [selectedAction, setSelectedAction] = useState<ActionType | 'BALANCE' | ''>('USAGE');
    const [selectedItems, setSelectedItems] = useState<string[]>([]);
    const [dateStart, setDateStart] = useState('');
    const [dateEnd, setDateEnd] = useState('');
    const [isBattalionMode, setIsBattalionMode] = useState(false);
    const [receiptLimit, setReceiptLimit] = useState(500);
    const [aggregateSummary, setAggregateSummary] = useState<any[]>([]);
    const [hasSearched, setHasSearched] = useState(false);

    // Derived tab
    const [onlyInStock, setOnlyInStock] = useState(true);

    // Serial tracking
    const [serialInput, setSerialInput] = useState('');
    const [serialResult, setSerialResult] = useState<{ serial: string; docs: SerializedItem[]; events: any[] } | null>(null);

    const catName = (id: string) => catalog.find(c => c.id === id)?.name || id;

    // --- AUTH (only ADMIN users of Bunker may use this app) ---
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (u) => {
            setUser(u);
            setIsAdmin(null);
            if (!u) { setIsAdmin(false); return; }
            try {
                const snap = await getDoc(doc(db, "users", u.email!));
                const admin = snap.exists() && snap.data().role === 'ADMIN';
                setIsAdmin(admin);
                if (admin) loadCatalog();
            } catch (e) {
                console.error("Profile load error", e);
                setIsAdmin(false);
            }
        });
        return () => unsubscribe();
    }, []);

    const handleLogin = async () => {
        try { await signInWithPopup(auth, provider); } catch (e) { console.error("Login error", e); }
    };
    const handleLogout = async () => {
        await signOut(auth);
        setCatalog([]); setReceipts([]); setInventory(null); setUsageReceipts(null); setSerialResult(null); setAggregateSummary([]);
    };

    const loadCatalog = async () => {
        const snap = await getDocs(collection(db, "catalog"));
        setCatalog(snap.docs.map(d => ({ ...d.data(), id: d.id } as CatalogItem)));
    };

    // Current stock straight from Bunker's inventory docs (one read per item x place)
    const loadInventory = async () => {
        setLoading(true);
        try {
            const snap = await getDocs(collection(db, "inventory"));
            setInventory(snap.docs.map(d => d.data() as InventoryRecord));
        } catch (e) { console.error(e); alert("שגיאה בטעינת המלאי"); }
        setLoading(false);
    };

    const loadUsage = async () => {
        setLoading(true);
        try {
            const snap = await getDocs(query(collection(db, "receipts"), where("type", "==", "USAGE"), limit(1000)));
            setUsageReceipts(snap.docs.map(d => ({ ...d.data(), id: d.id })));
        } catch (e) { console.error(e); alert("שגיאה בטעינת דיווחי השצ\"ל"); }
        setLoading(false);
    };

    useEffect(() => {
        if (activeTab !== 'DERIVED' || !isAdmin) return;
        if (inventory === null) loadInventory();
        if (usageReceipts === null) loadUsage();
    }, [activeTab, isAdmin]);

    // --- SERIAL TRACKING ---
    const handleSerialSearch = async () => {
        const sn = serialInput.trim();
        if (!sn) return;
        setLoading(true);
        setSerialResult(null);
        try {
            const [docsSnap, rcSnap] = await Promise.all([
                getDocs(query(collection(db, "serialized_items"), where("serialNumber", "==", sn), limit(20))),
                getDocs(query(collection(db, "receipts"), where("serialNumbers", "array-contains", sn), limit(200)))
            ]);
            const docs = docsSnap.docs.map(d => d.data() as SerializedItem);
            const events = rcSnap.docs.map(d => ({ ...d.data(), id: d.id } as any))
                .sort((a, b) => (a.timestamp?.seconds || 0) - (b.timestamp?.seconds || 0));
            setSerialResult({ serial: sn, docs, events });
        } catch (e: any) {
            console.error(e);
            alert("שגיאה בחיפוש הצ': " + (e?.message || e));
        }
        setLoading(false);
    };

    // --- ROUTINE (movements / balance) ---
    const handleSearch = async () => {
        setLoading(true);
        try {
            const summary: Record<string, any> = {};
            const unitName = (u: string) => isBattalionMode ? "כלל הגדוד" : u;
            const itemSelected = (id: string) => selectedItems.length === 0 || selectedItems.includes(id);

            if (selectedAction === 'BALANCE') {
                // Current stock: read from the inventory docs, not reconstructed from receipts
                let inv = inventory;
                if (inv === null) {
                    const snap = await getDocs(collection(db, "inventory"));
                    inv = snap.docs.map(d => d.data() as InventoryRecord);
                    setInventory(inv);
                }
                inv.forEach(rec => {
                    if (selectedUnits.length > 0 && !selectedUnits.includes(rec.unitId)) return;
                    if (!itemSelected(rec.sku)) return;
                    if (!rec.onHand && !rec.inStorage) return;
                    const key = isBattalionMode ? `all_${rec.sku}` : `${rec.unitId}_${rec.sku}`;
                    if (!summary[key]) summary[key] = { unit: unitName(rec.unitId), sku: rec.sku, itemName: catName(rec.sku), total: 0, storage: 0 };
                    summary[key].total += rec.onHand || 0;
                    summary[key].storage += rec.inStorage || 0;
                });
                setReceipts([]);
            } else {
                const constraints: any[] = [orderBy("timestamp", "desc")];
                if (dateStart) constraints.unshift(where("timestamp", ">=", Timestamp.fromDate(new Date(dateStart + 'T00:00:00'))));
                if (dateEnd) constraints.unshift(where("timestamp", "<=", Timestamp.fromDate(new Date(dateEnd + 'T23:59:59'))));
                constraints.push(limit(receiptLimit));
                const snap = await getDocs(query(collection(db, "receipts"), ...constraints));
                let data = snap.docs.map(d => ({ ...d.data(), id: d.id } as any));
                if (selectedUnits.length > 0) data = data.filter(r => selectedUnits.includes(r.unit));
                if (selectedAction) data = data.filter(r => r.type === selectedAction);
                if (selectedItems.length > 0) data = data.filter(r => r.items?.some((i: any) => selectedItems.includes(i.sku)));
                data.forEach(r => {
                    r.items?.forEach((item: any) => {
                        if (!itemSelected(item.sku)) return;
                        const key = isBattalionMode ? `all_${item.sku}` : `${r.unit}_${item.sku}`;
                        if (!summary[key]) summary[key] = { unit: unitName(r.unit || 'לא ידוע'), sku: item.sku, itemName: item.itemName || catName(item.sku), total: 0, storage: 0 };
                        summary[key].total += Number(item.quantity) || 0;
                    });
                });
                setReceipts(data);
                if (snap.size >= receiptLimit) alert(`נטענו ${receiptLimit} הקבלות האחרונות בטווח. ייתכן שיש עוד, שנה את הטווח או הגדל את "מספר קבלות מקסימלי".`);
            }
            setAggregateSummary(Object.values(summary));
            setHasSearched(true);
        } catch (e: any) {
            console.error("Search error", e);
            alert("שגיאה בטעינת נתונים: " + (e?.message || e));
        }
        setLoading(false);
    };

    const toggleSelection = (list: string[], setList: (l: string[]) => void, value: string) => {
        setList(list.includes(value) ? list.filter(v => v !== value) : [...list, value]);
    };

    const handleExportToExcel = () => {
        if (aggregateSummary.length === 0) { alert("אין נתוני סיכום לייצוא"); return; }
        try {
            const isBalance = selectedAction === 'BALANCE';
            const exportData = aggregateSummary.map(item => ({
                'יחידה/פלוגה': item.unit,
                'שם פריט': item.itemName,
                [isBalance ? 'מלאי ביד' : 'סך הכל']: item.total,
                ...(isBalance ? { 'באפסון': item.storage || 0 } : {}),
            }));
            const XLSX = (window as any).XLSX;
            if (!XLSX) { alert("ספריית האקסל לא נטענה כראוי"); return; }
            const ws = XLSX.utils.json_to_sheet(exportData);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "סיכום");
            XLSX.writeFile(wb, `באנקר_נתונים_סיכום_${new Date().toLocaleDateString('he-IL')}.xlsx`);
        } catch (e) { console.error("Export error", e); alert("שגיאה בייצוא לאקסל"); }
    };

    const handleExportSerial = () => {
        if (!serialResult) return;
        try {
            const XLSX = (window as any).XLSX;
            if (!XLSX) { alert("ספריית האקסל לא נטענה כראוי"); return; }
            const rows = serialResult.events.map(r => {
                const m = describeMove(r);
                return { 'תאריך': fmtDateTime(r.timestamp), 'קבלה': r.number, 'פעולה': actionLabel(r.type), 'מ': m.from, 'ל': m.to, 'מנפק/מבצע': r.issuerName || '', 'מקבל': r.receiverName || '', 'אירוע': r.eventName || '' };
            });
            const ws = XLSX.utils.json_to_sheet(rows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "מעקב צ'");
            XLSX.writeFile(wb, `מעקב_צ_${serialResult.serial}.xlsx`);
        } catch (e) { console.error(e); alert("שגיאה בייצוא לאקסל"); }
    };

    // --- DERIVED data ---
    const stockByUnit: Record<string, Record<string, InventoryRecord>> = {};
    (inventory || []).forEach(rec => {
        if (!stockByUnit[rec.sku]) stockByUnit[rec.sku] = {};
        stockByUnit[rec.sku][rec.unitId] = rec;
    });
    const stockRows = catalog.map(c => {
        const per = TABLE_UNITS.map(u => stockByUnit[c.id]?.[u]?.onHand || 0);
        const stored = TABLE_UNITS.map(u => stockByUnit[c.id]?.[u]?.inStorage || 0);
        const total = per.reduce((a, b) => a + b, 0) + stored.reduce((a, b) => a + b, 0);
        return { c, per, stored, total };
    }).filter(r => !onlyInStock || r.total > 0).sort((a, b) => (a.c.family || '').localeCompare(b.c.family || '') || a.c.name.localeCompare(b.c.name));

    const usageByUnit: Record<string, number> = {};
    (usageReceipts || []).forEach(r => { r.items?.forEach((i: any) => { usageByUnit[r.unit] = (usageByUnit[r.unit] || 0) + (Number(i.quantity) || 0); }); });
    const benchmarkingData = Object.entries(usageByUnit).map(([name, usage]) => ({ name, usage })).sort((a, b) => b.usage - a.usage);

    const tabBtn = (id: TabType, label: string, Icon: any, color: string) => (
        <button
            onClick={() => setActiveTab(id)}
            className={`py-4 px-2 font-bold text-sm border-b-2 transition-colors flex items-center gap-2 ${activeTab === id ? `border-${color}-500 text-${color}-600` : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
            <Icon size={18} /> {label}
        </button>
    );

    return (
        <div className="min-h-screen bg-gray-50 text-right" dir="rtl">
            <header className="bg-zinc-900 text-white p-4 shadow-lg sticky top-0 z-10">
                <div className="max-w-7xl mx-auto flex justify-between items-center text-right">
                    <h1 className="text-2xl font-bold flex items-center gap-3">
                        <img src="/logo.png" alt="Logo" className="w-10 h-10 rounded-full border-2 border-orange-500 shadow-sm" />
                        באנקר <span className="text-orange-500">נתונים</span>
                    </h1>
                    <div className="flex items-center gap-4">
                        {user ? (
                            <div className="flex items-center gap-3">
                                <div className="text-left hidden md:block">
                                    <div className="text-sm font-bold">{user.displayName}</div>
                                    <div className="text-[10px] text-zinc-400 leading-none">{user.email}</div>
                                </div>
                                <button onClick={handleLogout} className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors">
                                    <LogOut size={20} />
                                </button>
                            </div>
                        ) : (
                            <button onClick={handleLogin} className="bg-orange-600 hover:bg-orange-700 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all">
                                <LogIn size={18} /> התחבר עם Google
                            </button>
                        )}
                        <div className="text-[10px] text-zinc-500 hidden sm:block">v2.0</div>
                    </div>
                </div>
            </header>

            {!user ? (
                <div className="max-w-7xl mx-auto p-12 mt-12 text-center">
                    <div className="bg-white p-12 rounded-2xl shadow-xl border border-gray-100 max-w-md mx-auto">
                        <ShieldAlert size={64} className="text-orange-500 mx-auto mb-6" />
                        <h2 className="text-2xl font-bold text-gray-800 mb-2">נדרשת התחברות</h2>
                        <p className="text-gray-500 mb-8">כדי לצפות בנתונים עליך להזדהות באמצעות חשבון מנהל מורשה.</p>
                        <button onClick={handleLogin} className="w-full bg-zinc-900 text-white py-3 rounded-xl font-bold shadow-lg hover:bg-zinc-800 transition-all flex justify-center items-center gap-2">
                            <User size={20} /> התחבר עכשיו
                        </button>
                    </div>
                </div>
            ) : isAdmin === null ? (
                <div className="p-12 text-center text-gray-500">בודק הרשאות...</div>
            ) : isAdmin === false ? (
                <div className="max-w-7xl mx-auto p-12 mt-12 text-center">
                    <div className="bg-white p-12 rounded-2xl shadow-xl border border-red-100 max-w-md mx-auto">
                        <ShieldAlert size={64} className="text-red-500 mx-auto mb-6" />
                        <h2 className="text-2xl font-bold text-gray-800 mb-2">אין הרשאה</h2>
                        <p className="text-gray-500">האפליקציה זמינה למנהלי המערכת בלבד. התחבר עם חשבון מנהל.</p>
                    </div>
                </div>
            ) : (
                <>
                    <div className="bg-white border-b border-gray-200 sticky top-16 z-10 shadow-sm">
                        <div className="max-w-7xl mx-auto flex gap-6 px-4">
                            {tabBtn('SERIAL', "מעקב צ'", Search, 'orange')}
                            {tabBtn('ROUTINE', 'פעילות שוטפת', ArrowRightLeft, 'orange')}
                            {tabBtn('DERIVED', 'מלאי ונתונים נגזרים', BarChart3, 'blue')}
                        </div>
                    </div>

                    <main className="max-w-7xl mx-auto p-4 md:p-6">

                        {/* --- TAB: SERIAL TRACKING --- */}
                        {activeTab === 'SERIAL' && (
                            <div className="space-y-6">
                                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                    <h2 className="text-lg font-bold flex items-center gap-2 text-gray-800 mb-4"><Search size={20} className="text-orange-600" /> מעקב צ' אחורה</h2>
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            className="flex-1 p-3 border rounded-lg text-lg font-mono"
                                            placeholder="הכנס מספר צ' מדויק..."
                                            value={serialInput}
                                            onChange={e => setSerialInput(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') handleSerialSearch(); }}
                                        />
                                        <button onClick={handleSerialSearch} disabled={!serialInput.trim() || loading} className="bg-zinc-900 disabled:bg-gray-300 text-white px-6 rounded-lg font-bold flex items-center gap-2">
                                            <Search size={18} /> חפש
                                        </button>
                                    </div>
                                    <p className="text-xs text-gray-400 mt-2">מציג את כל הקבלות שבהן הופיע הצ', לפי סדר זמן, ואת מצבו הנוכחי במערכת. קבלות ישנות שנוצרו לפני הוספת רשימת הצ'ים לקבלה לא יופיעו.</p>
                                </div>

                                {serialResult && (
                                    <>
                                        {/* Current state + cross-check against the last receipt */}
                                        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                            <h3 className="font-bold text-gray-800 mb-3">מצב נוכחי של צ' <span className="font-mono">{serialResult.serial}</span></h3>
                                            {serialResult.docs.length === 0 ? (
                                                <div className="text-sm text-gray-500 flex items-center gap-2"><AlertTriangle size={16} className="text-yellow-500" /> הצ' לא קיים כרגע במערכת (ייתכן שנמחק, או שמעולם לא נקלט).</div>
                                            ) : serialResult.docs.map((d, i) => {
                                                const itemEvents = serialResult.events.filter(r => r.items?.some((it: any) => it.sku === d.sku && it.serials?.includes(d.serialNumber)));
                                                const last = itemEvents[itemEvents.length - 1];
                                                const exp = last ? expectedAfter(last) : null;
                                                const mismatch = exp && ((exp.owner && exp.owner !== d.owner) || (exp.location && exp.location !== d.location) || (exp.status && exp.status !== d.status));
                                                return (
                                                    <div key={i} className="border rounded-lg p-4 mb-3 bg-gray-50">
                                                        <div className="font-bold text-lg">{catName(d.sku)} <span className="text-xs font-mono text-gray-500">{itemCode(catalog.find(c => c.id === d.sku))}</span></div>
                                                        <div className="grid grid-cols-3 gap-4 mt-2 text-sm">
                                                            <div><div className="text-[10px] text-gray-500 font-bold">בעלים</div><div className="font-bold">{d.owner}</div></div>
                                                            <div><div className="text-[10px] text-gray-500 font-bold">מיקום פיזי</div><div className="font-bold">{d.location}</div></div>
                                                            <div><div className="text-[10px] text-gray-500 font-bold">סטטוס</div><div className="font-bold">{STATUS_LABELS[d.status] || d.status}</div></div>
                                                        </div>
                                                        {last && (mismatch ? (
                                                            <div className="mt-3 text-xs bg-red-50 border border-red-200 text-red-700 p-2 rounded flex items-center gap-2"><AlertTriangle size={14} /> המצב הנוכחי לא תואם לקבלה האחרונה (#{last.number}, {actionLabel(last.type)}). כדאי לבדוק עריכה ידנית או תקלה.</div>
                                                        ) : (
                                                            <div className="mt-3 text-xs bg-green-50 border border-green-200 text-green-700 p-2 rounded flex items-center gap-2"><CheckCircle2 size={14} /> המצב הנוכחי תואם לקבלה האחרונה (#{last.number}).</div>
                                                        ))}
                                                        {!last && <div className="mt-3 text-xs text-gray-500">אין קבלות מתועדות לצ' זה, ולכן לא ניתן לבצע הצלבה.</div>}
                                                    </div>
                                                );
                                            })}
                                        </div>

                                        {/* Timeline */}
                                        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                            <div className="flex justify-between items-center mb-4">
                                                <h3 className="font-bold text-gray-800">היסטוריה ({serialResult.events.length} קבלות)</h3>
                                                {serialResult.events.length > 0 && (
                                                    <button onClick={handleExportSerial} className="bg-green-50 text-green-700 hover:bg-green-100 px-3 py-2 rounded-lg font-bold text-xs flex items-center gap-2 border border-green-200"><FileDown size={16} /> הורד לאקסל</button>
                                                )}
                                            </div>
                                            {serialResult.events.length === 0 ? (
                                                <div className="text-sm text-gray-500">לא נמצאו קבלות לצ' זה.</div>
                                            ) : (
                                                <div className="space-y-3 border-r-2 border-orange-200 pr-4">
                                                    {serialResult.events.map(r => {
                                                        const m = describeMove(r);
                                                        const itemNames = (r.items || []).filter((it: any) => it.serials?.includes(serialResult.serial)).map((it: any) => it.itemName).join(', ');
                                                        return (
                                                            <div key={r.id} className="relative bg-gray-50 border rounded-lg p-3">
                                                                <div className="absolute -right-[25px] top-4 w-3 h-3 bg-orange-500 rounded-full border-2 border-white"></div>
                                                                <div className="flex justify-between items-start flex-wrap gap-1">
                                                                    <div className="font-bold">{actionLabel(r.type)} <span className="text-xs text-gray-500 font-normal">({itemNames})</span></div>
                                                                    <div className="text-xs text-gray-500">{fmtDateTime(r.timestamp)} · קבלה #{r.number}</div>
                                                                </div>
                                                                <div className="text-sm mt-1"><span className="font-bold">{m.from}</span> ← <span className="font-bold">{m.to}</span></div>
                                                                <div className="text-xs text-gray-600 mt-1">
                                                                    {r.issuerName && <>מנפק/מבצע: <b>{r.issuerName}</b></>}
                                                                    {r.receiverName && <> · מקבל: <b>{r.receiverName}</b></>}
                                                                    {r.eventName && <> · אירוע: <b>{r.eventName}</b></>}
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        )}

                        {/* --- TAB: ROUTINE --- */}
                        {activeTab === 'ROUTINE' && (
                            <div className="space-y-6">
                                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                    <h2 className="text-lg font-bold flex items-center gap-2 text-gray-800 mb-6 border-b pb-4"><Filter size={20} /> סינון וחיפוש</h2>
                                    <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                                        <div className="space-y-2">
                                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider">בחר פלוגות/יחידות</label>
                                            <div className="max-h-40 overflow-y-auto border rounded-lg p-2 bg-gray-50 space-y-1">
                                                {INITIAL_UNITS.map(u => (
                                                    <label key={u} className="flex items-center gap-2 p-1 hover:bg-gray-100 rounded cursor-pointer">
                                                        <input type="checkbox" checked={selectedUnits.includes(u)} onChange={() => toggleSelection(selectedUnits, setSelectedUnits, u)} className="w-4 h-4 text-orange-600 rounded" />
                                                        <span className="text-sm">{u}</span>
                                                    </label>
                                                ))}
                                            </div>
                                            <div className="text-[10px] text-gray-400">נבחרו: {selectedUnits.length} (ריק = הכל)</div>
                                        </div>

                                        <div className="space-y-2">
                                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider">בחר פריטים</label>
                                            <div className="max-h-40 overflow-y-auto border rounded-lg p-2 bg-gray-50 space-y-1">
                                                {catalog.map(c => (
                                                    <label key={c.id} className="flex items-center gap-2 p-1 hover:bg-gray-100 rounded cursor-pointer">
                                                        <input type="checkbox" checked={selectedItems.includes(c.id)} onChange={() => toggleSelection(selectedItems, setSelectedItems, c.id)} className="w-4 h-4 text-orange-600 rounded" />
                                                        <span className="text-sm truncate" title={c.name}>{c.name}</span>
                                                    </label>
                                                ))}
                                            </div>
                                            <div className="text-[10px] text-gray-400">נבחרו: {selectedItems.length} (ריק = הכל)</div>
                                        </div>

                                        <div className="space-y-4">
                                            <div>
                                                <label className="block text-xs font-bold text-gray-500 mb-1">סוג פעולה</label>
                                                <select className="w-full p-2 border rounded-lg bg-white text-sm font-bold shadow-sm" value={selectedAction} onChange={e => setSelectedAction(e.target.value as any)}>
                                                    <option value="BALANCE">📦 מלאי נוכחי</option>
                                                    {(Object.keys(ACTION_LABELS) as ActionType[]).map(t => <option key={t} value={t}>{ACTION_LABELS[t]}</option>)}
                                                    <option value="">🔍 הכל (ללא סינון סוג)</option>
                                                </select>
                                            </div>
                                            <div className="flex items-center gap-2 p-2 bg-blue-50 border border-blue-100 rounded-lg">
                                                <input type="checkbox" id="battalionMode" checked={isBattalionMode} onChange={(e) => setIsBattalionMode(e.target.checked)} className="w-4 h-4 text-blue-600 rounded cursor-pointer" />
                                                <label htmlFor="battalionMode" className="text-xs font-bold text-blue-800 cursor-pointer select-none">סיכום גדודי כולל (ללא פירוט יחידות)</label>
                                            </div>
                                            {selectedAction !== 'BALANCE' && (
                                                <>
                                                    <div className="grid grid-cols-2 gap-2">
                                                        <div><label className="block text-xs font-bold text-gray-500 mb-1">מתאריך</label><input type="date" className="w-full p-1.5 border rounded-lg bg-gray-50 text-xs" value={dateStart} onChange={e => setDateStart(e.target.value)} /></div>
                                                        <div><label className="block text-xs font-bold text-gray-500 mb-1">עד תאריך</label><input type="date" className="w-full p-1.5 border rounded-lg bg-gray-50 text-xs" value={dateEnd} onChange={e => setDateEnd(e.target.value)} /></div>
                                                    </div>
                                                    <div>
                                                        <label className="block text-xs font-bold text-gray-500 mb-1">מספר קבלות מקסימלי</label>
                                                        <select className="w-full p-1.5 border rounded-lg bg-gray-50 text-xs" value={receiptLimit} onChange={e => setReceiptLimit(Number(e.target.value))}>
                                                            <option value={200}>200</option><option value={500}>500</option><option value={1000}>1000</option><option value={2000}>2000</option>
                                                        </select>
                                                    </div>
                                                </>
                                            )}
                                        </div>

                                        <div className="flex flex-col gap-2 justify-end">
                                            <button onClick={handleSearch} disabled={loading} className="w-full bg-zinc-900 hover:bg-zinc-800 disabled:bg-gray-400 text-white py-3 rounded-xl font-bold flex justify-center items-center gap-2 shadow-lg">
                                                <Search size={20} /> {loading ? 'טוען...' : 'בצע חתך נתונים'}
                                            </button>
                                            <button onClick={handleExportToExcel} className="w-full bg-green-50 text-green-700 hover:bg-green-100 py-2 rounded-lg font-bold text-sm flex justify-center items-center gap-2 border border-green-200">
                                                <FileDown size={18} /> הורד דוח לאקסל
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {aggregateSummary.length > 0 ? (
                                    <div className="bg-gradient-to-r from-zinc-900 to-zinc-800 text-white p-6 rounded-2xl shadow-xl border-l-8 border-orange-500">
                                        <div className="flex items-center gap-3 mb-4">
                                            <div className="bg-orange-500 p-2 rounded-lg"><ClipboardCheck size={24} /></div>
                                            <h2 className="text-xl font-bold tracking-tight">סיכום {selectedAction === 'BALANCE' ? 'מלאי נוכחי' : (selectedAction ? actionLabel(selectedAction) : 'פעולות')}{selectedAction !== 'BALANCE' && ` (${receipts.length} קבלות)`}</h2>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                            {aggregateSummary.map((item, i) => (
                                                <div key={i} className="bg-zinc-700/50 p-4 rounded-xl border border-zinc-600 flex justify-between items-center">
                                                    <div>
                                                        <div className="text-xs text-zinc-400 font-bold">{item.unit}</div>
                                                        <div className="text-sm font-semibold">{item.itemName}</div>
                                                    </div>
                                                    <div className="text-2xl font-black text-orange-400">{item.total} <span className="text-[10px] text-zinc-400 font-normal">יח'</span>{item.storage > 0 && <div className="text-[10px] text-purple-300 font-normal text-left">🔒 {item.storage} באפסון</div>}</div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    hasSearched && !loading && (
                                        <div className="bg-white p-12 rounded-xl border-2 border-dashed text-center text-gray-400">
                                            <Search size={48} className="mx-auto mb-4 opacity-20" />
                                            <p>לא נמצאו נתונים התואמים לסינון הנבחר.</p>
                                        </div>
                                    )
                                )}
                            </div>
                        )}

                        {/* --- TAB: DERIVED --- */}
                        {activeTab === 'DERIVED' && (
                            <div className="space-y-6">
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                        <div className="flex justify-between items-start mb-4">
                                            <div className="p-3 bg-blue-100 rounded-lg text-blue-600"><PackageOpen size={24} /></div>
                                            <button onClick={loadInventory} className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded font-bold">רענן</button>
                                        </div>
                                        <h3 className="font-bold text-lg mb-1">מלאי לפי יחידה</h3>
                                        <p className="text-sm text-gray-500 mb-4">סך היחידות (ביד ובאפסון) בכל מקום, מתוך רשומות המלאי של Bunker</p>
                                        <div className="space-y-2">
                                            {INITIAL_UNITS.map(u => {
                                                const total = (inventory || []).filter(r => r.unitId === u).reduce((a, r) => a + (r.onHand || 0) + (r.inStorage || 0), 0);
                                                return (
                                                    <div key={u} className="flex justify-between border-b pb-1 text-sm">
                                                        <span className="font-bold">{u}</span>
                                                        <span className="text-blue-600 font-mono">{total.toLocaleString()}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>

                                    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                        <div className="p-3 bg-blue-100 rounded-lg text-blue-600 w-fit mb-4"><BarChart3 size={24} /></div>
                                        <h3 className="font-bold text-lg mb-1">דירוג צריכה</h3>
                                        <p className="text-sm text-gray-500 mb-4">סך השצ"ל (דיווחי USAGE) לפי פלוגה{usageReceipts && usageReceipts.length >= 1000 ? ' (1000 הדיווחים הראשונים)' : ''}</p>
                                        <div className="h-48 flex items-end gap-2 px-2">
                                            {benchmarkingData.length === 0 ? (
                                                <div className="w-full text-center text-xs text-gray-400 italic mb-20">אין נתוני צריכה</div>
                                            ) : benchmarkingData.slice(0, 6).map(item => {
                                                const max = benchmarkingData[0].usage || 1;
                                                return (
                                                    <div key={item.name} className="flex-1 flex flex-col items-center gap-1">
                                                        <div className="text-[10px] font-bold">{item.usage}</div>
                                                        <div className="w-full bg-blue-500 rounded-t-sm" style={{ height: `${(item.usage / max) * 100}%` }} title={`${item.name}: ${item.usage}`}></div>
                                                        <div className="text-[10px] truncate w-full text-center font-bold" title={item.name}>{item.name}</div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>

                                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                    <div className="flex justify-between items-center mb-4">
                                        <h3 className="font-bold text-lg">מלאי לפי פריט ויחידה</h3>
                                        <label className="flex items-center gap-2 text-sm font-bold cursor-pointer"><input type="checkbox" checked={onlyInStock} onChange={e => setOnlyInStock(e.target.checked)} className="w-4 h-4 accent-orange-600" /> רק פריטים עם מלאי</label>
                                    </div>
                                    <div className="overflow-auto max-h-[60vh]">
                                        <table className="w-full text-sm text-right whitespace-nowrap">
                                            <thead className="bg-zinc-100 text-xs sticky top-0">
                                                <tr><th className="p-2 sticky right-0 bg-zinc-100">פריט</th>{UNITS_BEFORE_TOTAL.map(u => <th key={u} className="p-2 text-center">{u}</th>)}<th className="p-2 text-center bg-blue-50">סה"כ בגדוד</th>{UNITS_AFTER_TOTAL.map(u => <th key={u} className="p-2 text-center">{u}</th>)}</tr>
                                            </thead>
                                            <tbody className="divide-y">
                                                {stockRows.map(({ c, per, stored, total }) => (
                                                    <tr key={c.id}>
                                                        <td className="p-2 font-bold sticky right-0 bg-white">{c.name}</td>
                                                        {per.slice(0, UNITS_BEFORE_TOTAL.length).map((n, i) => <td key={i} className={`p-2 text-center ${!n && !stored[i] ? 'text-zinc-200' : ''}`}><div className="font-bold">{n || '-'}</div>{stored[i] > 0 && <div className="text-[10px] text-purple-600">🔒{stored[i]}</div>}</td>)}
                                                        <td className="p-2 text-center font-bold bg-blue-50">{total || '-'}</td>
                                                        {per.slice(UNITS_BEFORE_TOTAL.length).map((n, j) => { const i = UNITS_BEFORE_TOTAL.length + j; return <td key={i} className={`p-2 text-center ${!n && !stored[i] ? 'text-zinc-200' : ''}`}><div className="font-bold">{n || '-'}</div>{stored[i] > 0 && <div className="text-[10px] text-purple-600">🔒{stored[i]}</div>}</td>; })}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        {inventory !== null && stockRows.length === 0 && <div className="text-center text-gray-400 p-6">אין פריטים להצגה</div>}
                                    </div>
                                </div>
                            </div>
                        )}

                    </main>
                </>
            )}
        </div>
    );
}
