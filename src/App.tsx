import { useState, useEffect } from 'react';
import { initializeApp } from "firebase/app";
import {
    getFirestore, collection, getDocs, query, orderBy, where, Timestamp
} from "firebase/firestore";
import {
    getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged
} from "firebase/auth";
import {
    BarChart3, Settings, Database,
    Menu, ShieldAlert, FileDown, Search, Filter,
    ArrowRightLeft, TrendingUp, AlertTriangle, PackageOpen,
    LogIn, LogOut, User, ClipboardCheck
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
export type TabType = 'ROUTINE' | 'DERIVED' | 'FUTURE';
export type ActionType = 'ISSUE' | 'RETURN' | 'USAGE' | 'STORE' | 'RELEASE' | 'RECEIVE_SUPPLY' | 'RETURN_SUPPLY';

const INITIAL_UNITS = ['בונקר', 'פלסר', 'פלחהן', 'פלנט', 'מסייעת', 'פלתצ', 'פלסמ'];

export default function BunkerDataApp() {
    const [user, setUser] = useState<any>(null);
    const [activeTab, setActiveTab] = useState<TabType>('ROUTINE');
    const [loading, setLoading] = useState(false);

    // Data State
    const [receipts, setReceipts] = useState<any[]>([]);
    const [catalog, setCatalog] = useState<any[]>([]);

    // מצבי סינון (Filter State)
    const [selectedUnits, setSelectedUnits] = useState<string[]>([]);
    const [selectedAction, setSelectedAction] = useState<ActionType | ''>('USAGE');
    const [selectedItems, setSelectedItems] = useState<string[]>([]);
    const [dateStart, setDateStart] = useState('');
    const [dateEnd, setDateEnd] = useState('');
    const [isBattalionMode, setIsBattalionMode] = useState(false);

    // מצבי חישוב (Derived/Aggregate State)
    const [unitBalances, setUnitBalances] = useState<any>({});
    const [benchmarkingData, setBenchmarkingData] = useState<any[]>([]);
    const [aggregateSummary, setAggregateSummary] = useState<any[]>([]);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (u) => {
            setUser(u);
            if (u) loadData();
        });
        return () => unsubscribe();
    }, []);

    const loadData = async () => {
        setLoading(true);
        try {
            const catalogSnap = await getDocs(collection(db, "catalog"));
            const catalogData = catalogSnap.docs.map(d => ({ ...d.data(), id: d.id }));
            setCatalog(catalogData);

            // Load all relevant receipts for analysis
            const q = query(collection(db, "receipts"), orderBy("timestamp", "desc"));
            const snap = await getDocs(q);
            const allReceipts = snap.docs.map(d => {
                const data = d.data();
                return {
                    ...data,
                    id: d.id,
                    timestampStr: data.timestamp ? new Date(data.timestamp.seconds * 1000).toLocaleDateString() : 'אין תאריך'
                };
            });
            setReceipts(allReceipts);
            calculateDerivedData(allReceipts);
        } catch (e) {
            console.error("Error loading initial data", e);
        }
        setLoading(false);
    };

    const handleLogin = async () => {
        try {
            await signInWithPopup(auth, provider);
        } catch (e) {
            console.error("Login error", e);
        }
    };

    const handleLogout = async () => {
        await signOut(auth);
        setReceipts([]);
        setCatalog([]);
        setUnitBalances({});
        setBenchmarkingData([]);
    };

    const calculateDerivedData = (data: any[]) => {
        const balances: any = {};
        const usageByUnit: any = {};

        data.forEach(r => {
            const unit = r.unit;
            if (!unit || unit === 'בונקר') return;

            if (!balances[unit]) balances[unit] = {};
            if (!usageByUnit[unit]) usageByUnit[unit] = 0;

            r.items?.forEach((item: any) => {
                const sku = item.sku;
                if (!sku) return;
                if (!balances[unit][sku]) balances[unit][sku] = 0;

                const qty = Number(item.quantity) || 0;

                if (r.type === 'ISSUE') {
                    balances[unit][sku] += qty;
                } else if (r.type === 'RETURN') {
                    balances[unit][sku] -= qty;
                } else if (r.type === 'USAGE') {
                    balances[unit][sku] -= qty;
                    usageByUnit[unit] += qty;
                }
            });
        });

        setUnitBalances(balances);

        // Benchmarking: Usage per unit
        const bench = Object.keys(usageByUnit).map(unit => ({
            name: unit,
            usage: usageByUnit[unit]
        })).sort((a, b) => b.usage - a.usage);
        setBenchmarkingData(bench);
    };

    const handleSearch = async () => {
        setLoading(true);
        try {
            let q = query(collection(db, "receipts"), orderBy("timestamp", "desc"));

            const snap = await getDocs(q);
            let data = snap.docs.map(d => {
                const data = d.data();
                return {
                    ...data,
                    id: d.id,
                    timestampStr: data.timestamp ? new Date(data.timestamp.seconds * 1000).toLocaleDateString() : 'אין תאריך'
                };
            });

            // סינון יחידות
            if (selectedUnits.length > 0) {
                data = data.filter((r: any) => selectedUnits.includes(r.unit));
            }

            // סינון סוג פעולה
            if (selectedAction) {
                data = data.filter((r: any) => r.type === selectedAction);
            }

            // סינון תאריכים
            if (dateStart) {
                const start = new Date(dateStart).getTime();
                data = data.filter((r: any) => r.timestamp && r.timestamp.seconds * 1000 >= start);
            }
            if (dateEnd) {
                const end = new Date(dateEnd).getTime();
                data = data.filter((r: any) => r.timestamp && r.timestamp.seconds * 1000 <= end);
            }

            // סינון פריטים
            if (selectedItems.length > 0) {
                data = data.filter((r: any) =>
                    r.items?.some((i: any) => selectedItems.includes(i.sku) || selectedItems.includes(i.id))
                );
            }

            setReceipts(data);
            calculateDerivedData(data);
            calculateAggregateSummary(data);
        } catch (e) {
            console.error("Search error", e);
            alert("שגיאה בטעינת נתונים");
        }
        setLoading(false);
    };

    const calculateAggregateSummary = (data: any[]) => {
        const summary: any = {};

        data.forEach(r => {
            // הוסר התנאי המגביל רק ל-USAGE כדי לתמוך בכל סוגי הסינון
            r.items?.forEach((item: any) => {
                const sku = item.sku;
                // אם במצב גדודי - משתמשים בשם גנרי "כלל הגדוד"
                const unitName = isBattalionMode ? "כלל הגדוד" : (r.unit || "לא ידוע");
                if (!sku) return;

                if (selectedItems.length > 0 && !selectedItems.includes(sku) && !selectedItems.includes(item.id)) return;

                // מפתח האגרגציה משתנה לפי המצב
                const key = isBattalionMode ? `battalion_${sku}` : `${unitName}_${sku}`;

                if (!summary[key]) {
                    summary[key] = {
                        unit: unitName,
                        sku,
                        itemName: item.itemName || 'פריט ללא שם',
                        total: 0
                    };
                }
                summary[key].total += (Number(item.quantity) || 0);
            });
        });

        setAggregateSummary(Object.values(summary));
    };

    const toggleSelection = (list: string[], setList: (l: string[]) => void, value: string) => {
        if (list.includes(value)) {
            setList(list.filter(v => v !== value));
        } else {
            setList([...list, value]);
        }
    };

    const handleExportToExcel = () => {
        if (aggregateSummary.length === 0) {
            alert("אין נתוני סיכום לייצוא");
            return;
        }

        try {
            // הכנת נתוני הסיכום לייצוא
            const exportData = aggregateSummary.map(item => ({
                'יחידה/פלוגה': item.unit,
                'שם פריט': item.itemName,
                'סך הכל (שצ"ל)': item.total,
                'יחידות מידה': "יח'"
            }));

            const XLSX = (window as any).XLSX;
            if (!XLSX) {
                alert("ספריית האקסל לא נטענה כראוי");
                return;
            }

            const ws = XLSX.utils.json_to_sheet(exportData);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "סיכום מנהלים");

            XLSX.writeFile(wb, `באנקר_נתונים_סיכום_${new Date().toLocaleDateString()}.xlsx`);
        } catch (e) {
            console.error("Export error", e);
            alert("שגיאה בייצוא לאקסל");
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 text-right" dir="rtl">
            {/* Header */}
            <header className="bg-zinc-900 text-white p-4 shadow-lg sticky top-0 z-10">
                <div className="max-w-7xl mx-auto flex justify-between items-center text-right">
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Database className="text-orange-500" />
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
                        <div className="text-[10px] text-zinc-500 hidden sm:block">v1.1</div>
                    </div>
                </div>
            </header>

            {!user ? (
                <div className="max-w-7xl mx-auto p-12 mt-12 text-center">
                    <div className="bg-white p-12 rounded-2xl shadow-xl border border-gray-100 max-w-md mx-auto">
                        <ShieldAlert size={64} className="text-orange-500 mx-auto mb-6" />
                        <h2 className="text-2xl font-bold text-gray-800 mb-2">נדרשת התחבורת</h2>
                        <p className="text-gray-500 mb-8">כדי לצפות ולהפיק דוחו"ת נתונים, עליך להזדהות באמצעות חשבון מורשה.</p>
                        <button onClick={handleLogin} className="w-full bg-zinc-900 text-white py-3 rounded-xl font-bold shadow-lg hover:bg-zinc-800 transition-all flex justify-center items-center gap-2">
                            <User size={20} /> התחבר עכשיו
                        </button>
                    </div>
                </div>
            ) : (
                <>

                    {/* Main Tabs */}
                    <div className="bg-white border-b border-gray-200 sticky top-16 z-10 shadow-sm">
                        <div className="max-w-7xl mx-auto flex gap-6 px-4">
                            <button
                                onClick={() => setActiveTab('ROUTINE')}
                                className={`py-4 px-2 font-bold text-sm border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'ROUTINE' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                            >
                                <ArrowRightLeft size={18} />
                                פעילות שוטפת
                            </button>
                            <button
                                onClick={() => setActiveTab('DERIVED')}
                                className={`py-4 px-2 font-bold text-sm border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'DERIVED' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                            >
                                <BarChart3 size={18} />
                                תובנות ונתונים נגזרים
                            </button>
                            <button
                                onClick={() => setActiveTab('FUTURE')}
                                className={`py-4 px-2 font-bold text-sm border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'FUTURE' ? 'border-purple-500 text-purple-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                            >
                                <TrendingUp size={18} />
                                חיזוי לעתיד
                            </button>
                        </div>
                    </div>

                    <main className="max-w-7xl mx-auto p-4 md:p-6">

                        {/* --- TAB 1: ROUTINE --- */}
                        {activeTab === 'ROUTINE' && (
                            <div className="space-y-6 animate-in slide-in-from-bottom-2 duration-500">
                                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                    <h2 className="text-lg font-bold mb-4 flex items-center gap-2 text-gray-800"><Filter size={20} /> סינון וחיפוש (עבור תשובה סופית)</h2>

                                    <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                                        {/* בחירת יחידות */}
                                        <div className="space-y-2">
                                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider">בחר פלוגות/יחידות</label>
                                            <div className="max-h-40 overflow-y-auto border rounded-lg p-2 bg-gray-50 space-y-1">
                                                {INITIAL_UNITS.map(u => (
                                                    <label key={u} className="flex items-center gap-2 p-1 hover:bg-gray-100 rounded cursor-pointer transition-colors">
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedUnits.includes(u)}
                                                            onChange={() => toggleSelection(selectedUnits, setSelectedUnits, u)}
                                                            className="w-4 h-4 text-orange-600 rounded"
                                                        />
                                                        <span className="text-sm">{u}</span>
                                                    </label>
                                                ))}
                                            </div>
                                            <div className="text-[10px] text-gray-400">נבחרו: {selectedUnits.length}</div>
                                        </div>

                                        {/* בחירת פריטים */}
                                        <div className="space-y-2">
                                            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider">בחר פריטים (מק"טים)</label>
                                            <div className="max-h-40 overflow-y-auto border rounded-lg p-2 bg-gray-50 space-y-1">
                                                {catalog.map(c => (
                                                    <label key={c.id} className="flex items-center gap-2 p-1 hover:bg-gray-100 rounded cursor-pointer transition-colors">
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedItems.includes(c.id) || selectedItems.includes(c.sku)}
                                                            onChange={() => toggleSelection(selectedItems, setSelectedItems, c.sku || c.id)}
                                                            className="w-4 h-4 text-orange-600 rounded"
                                                        />
                                                        <span className="text-sm truncate" title={c.name}>{c.name}</span>
                                                    </label>
                                                ))}
                                            </div>
                                            <div className="text-[10px] text-gray-400">נבחרו: {selectedItems.length}</div>
                                        </div>

                                        {/* סוג פעולה ותאריכים */}
                                        <div className="space-y-4">
                                            <div>
                                                <label className="block text-xs font-bold text-gray-500 mb-1">סוג פעולה</label>
                                                <select className="w-full p-2 border rounded-lg bg-gray-50 text-sm" value={selectedAction} onChange={e => setSelectedAction(e.target.value as ActionType)}>
                                                    <option value="">הכל (כולל ניפוק/החזרה)</option>
                                                    <option value="USAGE">שצ"ל בלבד (USAGE)</option>
                                                    <option value="ISSUE">ניפוק בלבד (ISSUE)</option>
                                                    <option value="RETURN">החזרה בלבד (RETURN)</option>
                                                </select>
                                            </div>
                                            <div className="flex items-center gap-2 p-2 bg-blue-50 border border-blue-100 rounded-lg cursor-pointer hover:bg-blue-100 transition-colors">
                                                <input
                                                    type="checkbox"
                                                    id="battalionMode"
                                                    checked={isBattalionMode}
                                                    onChange={(e) => setIsBattalionMode(e.target.checked)}
                                                    className="w-4 h-4 text-blue-600 rounded cursor-pointer"
                                                />
                                                <label htmlFor="battalionMode" className="text-xs font-bold text-blue-800 cursor-pointer select-none">סיכום גדודי כולל (ללא פלוגות)</label>
                                            </div>
                                            <div className="grid grid-cols-2 gap-2">
                                                <div>
                                                    <label className="block text-xs font-bold text-gray-500 mb-1">מתאריך</label>
                                                    <input type="date" className="w-full p-1.5 border rounded-lg bg-gray-50 text-xs" value={dateStart} onChange={e => setDateStart(e.target.value)} />
                                                </div>
                                                <div>
                                                    <label className="block text-xs font-bold text-gray-500 mb-1">עד תאריך</label>
                                                    <input type="date" className="w-full p-1.5 border rounded-lg bg-gray-50 text-xs" value={dateEnd} onChange={e => setDateEnd(e.target.value)} />
                                                </div>
                                            </div>
                                        </div>

                                        {/* כפתורי פעולה */}
                                        <div className="flex flex-col gap-2 justify-end">
                                            <button onClick={handleSearch} className="w-full bg-zinc-900 hover:bg-zinc-800 text-white py-3 rounded-xl font-bold flex justify-center items-center gap-2 shadow-lg transition-all transform active:scale-95">
                                                <Search size={20} /> בצע חתך נתונים
                                            </button>
                                            <button onClick={handleExportToExcel} className="w-full bg-green-50 text-green-700 hover:bg-green-100 py-2 rounded-lg font-bold text-sm flex justify-center items-center gap-2 border border-green-200 transition-colors">
                                                <FileDown size={18} /> הורד דוח לאקסל
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* SECTION: THE "FINAL ANSWER" SUMMARY */}
                                {aggregateSummary.length > 0 ? (
                                    <div className="bg-gradient-to-r from-zinc-900 to-zinc-800 text-white p-6 rounded-2xl shadow-xl border-l-8 border-orange-500 animate-in fade-in zoom-in duration-300">
                                        <div className="flex items-center gap-3 mb-4">
                                            <div className="bg-orange-500 p-2 rounded-lg"><ClipboardCheck size={24} /></div>
                                            <h2 className="text-xl font-bold tracking-tight">סיכום מנהלים (תשובה סופית)</h2>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                            {aggregateSummary.map((item, i) => (
                                                <div key={i} className="bg-zinc-700/50 p-4 rounded-xl border border-zinc-600 flex justify-between items-center hover:bg-zinc-700 transition-colors">
                                                    <div>
                                                        <div className="text-xs text-zinc-400 font-bold">{item.unit}</div>
                                                        <div className="text-sm font-semibold">{item.itemName}</div>
                                                    </div>
                                                    <div className="text-2xl font-black text-orange-400">{item.total} <span className="text-[10px] text-zinc-400 font-normal">יח'</span></div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    !loading && (
                                        <div className="bg-white p-12 rounded-xl border-2 border-dashed text-center text-gray-400">
                                            <Search size={48} className="mx-auto mb-4 opacity-20" />
                                            <p>לא נמצאו דיווחים התואמים לסינון הנבחר.</p>
                                            <p className="text-xs mt-1">נסה לשנות את סוג הפעולה, הפריטים או היחידות.</p>
                                        </div>
                                    )
                                )}
                            </div>
                        )}

                        {/* --- TAB 2: DERIVED --- */}
                        {activeTab === 'DERIVED' && (
                            <div className="space-y-6 animate-in slide-in-from-bottom-2 duration-500">
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                                    {/* Unit Balance Card */}
                                    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                        <div className="flex justify-between items-start mb-4">
                                            <div className="p-3 bg-blue-100 rounded-lg text-blue-600"><PackageOpen size={24} /></div>
                                            <span className="bg-green-100 text-green-800 text-xs px-2 py-1 rounded font-bold">פעיל</span>
                                        </div>
                                        <h3 className="font-bold text-lg mb-1">מאזן יחידה נוכחי</h3>
                                        <p className="text-sm text-gray-500 mb-4">מלאי שנשאר אצל היחידות (ניפוק פחות שימוש והחזרה)</p>
                                        <div className="max-h-48 overflow-y-auto space-y-2">
                                            {Object.keys(unitBalances).length === 0 ? (
                                                <div className="text-xs text-gray-400 italic">אין נתונים מאוזנים</div>
                                            ) : (
                                                Object.keys(unitBalances).map(unit => (
                                                    <div key={unit} className="flex justify-between border-b pb-1 text-sm">
                                                        <span className="font-bold">{unit}</span>
                                                        <span className="text-blue-600 font-mono">
                                                            {String(Object.values(unitBalances[unit]).reduce((a: any, b: any) => Number(a) + Number(b), 0))} פריטים
                                                        </span>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    </div>

                                    {/* Benchmarking Card */}
                                    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                        <div className="flex justify-between items-start mb-4">
                                            <div className="p-3 bg-blue-100 rounded-lg text-blue-600"><BarChart3 size={24} /></div>
                                            <span className="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded font-bold">ניתוח</span>
                                        </div>
                                        <h3 className="font-bold text-lg mb-1">דירוג צריכה (Benchmarking)</h3>
                                        <p className="text-sm text-gray-500 mb-4">השוואת סך השצ"ל (USAGE) בין הפלוגות</p>
                                        <div className="h-48 flex items-end gap-2 px-2">
                                            {benchmarkingData.length === 0 ? (
                                                <div className="w-full text-center text-xs text-gray-400 italic mb-20">אין נתוני צריכה</div>
                                            ) : (
                                                benchmarkingData.slice(0, 5).map(item => {
                                                    const max = benchmarkingData[0].usage || 1;
                                                    const height = (item.usage / max) * 100;
                                                    return (
                                                        <div key={item.name} className="flex-1 flex flex-col items-center gap-1">
                                                            <div
                                                                className="w-full bg-blue-500 rounded-t-sm transition-all duration-1000"
                                                                style={{ height: `${height}%` }}
                                                                title={`${item.name}: ${item.usage}`}
                                                            ></div>
                                                            <div className="text-[10px] truncate w-full text-center font-bold" title={item.name}>{item.name}</div>
                                                        </div>
                                                    );
                                                })
                                            )}
                                        </div>
                                    </div>

                                    {/* Loss Analysis Card (Basic Discrepancy) */}
                                    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                        <div className="flex justify-between items-start mb-4">
                                            <div className="p-3 bg-red-100 rounded-lg text-red-600"><AlertTriangle size={24} /></div>
                                            <span className="bg-gray-100 text-gray-500 text-xs px-2 py-1 rounded font-bold">ניסיון</span>
                                        </div>
                                        <h3 className="font-bold text-lg mb-1">ניתוח אובדן פוטנציאלי</h3>
                                        <p className="text-sm text-gray-500 mb-4">זיהוי מקרים של ניפוק ללא דיווח משלים</p>
                                        <div className="space-y-3">
                                            <div className="bg-red-50 p-3 rounded-lg border border-red-100">
                                                <div className="text-xs text-red-800 font-bold mb-1 italic">מנגנון בהרצה...</div>
                                                <div className="text-sm text-red-700">בדיקה מול יתרות המלאי ב-Bunker...</div>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                    <h3 className="font-bold text-lg mb-4">פירוט מאזן פריטים לפי יחידה</h3>
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                                        {Object.keys(unitBalances).map(unit => (
                                            <div key={unit} className="border p-4 rounded-lg bg-gray-50">
                                                <div className="font-bold border-b pb-2 mb-2 text-zinc-900">{unit}</div>
                                                {Object.keys(unitBalances[unit]).map(sku => {
                                                    const qty = unitBalances[unit][sku];
                                                    if (qty === 0) return null;
                                                    const itemName = catalog.find((i: any) => i.id === sku || i.sku === sku)?.name || sku;
                                                    return (
                                                        <div key={sku} className="flex justify-between text-xs py-1">
                                                            <span>{itemName}</span>
                                                            <span className={`font-bold ${qty > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                                                                {qty}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* --- TAB 3: FUTURE --- */}
                        {activeTab === 'FUTURE' && (
                            <div className="space-y-6 animate-in slide-in-from-bottom-2 duration-500">
                                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
                                    <div className="flex items-center gap-3 mb-6">
                                        <TrendingUp className="text-purple-600" size={28} />
                                        <div>
                                            <h2 className="text-xl font-bold">תחזית מלאי ורכש</h2>
                                            <p className="text-sm text-gray-500">מבוסס על קצב צריכה ב-30 הימים האחרונים</p>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        {/* Runway Card */}
                                        <div className="border rounded-xl p-5 bg-purple-50 border-purple-100">
                                            <h3 className="font-bold text-lg mb-4 text-purple-900">אורך נשימה (Inventory Runway)</h3>
                                            <div className="space-y-4">
                                                {benchmarkingData.slice(0, 3).map(u => (
                                                    <div key={u.name} className="bg-white p-3 rounded-lg shadow-sm">
                                                        <div className="flex justify-between mb-1">
                                                            <span className="font-bold text-gray-700">{u.name}</span>
                                                            <span className="text-purple-600 font-bold">~14 ימים</span>
                                                        </div>
                                                        <div className="w-full bg-gray-100 h-2 rounded-full overflow-hidden">
                                                            <div className="bg-green-500 h-full w-[65%]"></div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Recommendations */}
                                        <div className="border rounded-xl p-5 bg-orange-50 border-orange-100">
                                            <h3 className="font-bold text-lg mb-4 text-orange-900">המלצות רכש חכמות</h3>
                                            <div className="space-y-4 text-sm">
                                                <div className="flex items-start gap-2 text-orange-800">
                                                    <ShieldAlert size={18} className="shrink-0" />
                                                    <p><strong>מחסור צפוי:</strong> פריט "5.56 לבן" בקצב צריכה גבוה מהרגיל. מומלץ להזמין 2000 יח'.</p>
                                                </div>
                                                <div className="flex items-start gap-2 text-orange-800">
                                                    <AlertTriangle size={18} className="shrink-0" />
                                                    <p><strong>מלאי מת:</strong> פריט "מטען חי" לא בשימוש ב-60 הימים האחרונים. שקול זיכוי.</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="mt-8 p-12 flex flex-col items-center justify-center border-2 border-dashed rounded-2xl bg-gray-50">
                                        <Settings size={48} className="text-gray-300 animate-spin-slow mb-4" />
                                        <p className="text-gray-500 font-bold text-lg">אלגוריתם ה-AI לומד את הנתונים...</p>
                                        <p className="text-gray-400 text-sm mt-1">ככל שיהיו יותר דיווחים, התחזית תהיה מדויקת יותר</p>
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
