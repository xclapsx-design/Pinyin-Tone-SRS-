import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Download, Upload, RotateCcw, SkipForward, ListFilter, Info } from "lucide-react";
import { pinyin } from "pinyin-pro"; // NPM: pinyin-pro

/**
 * 2000字 SRS 單檔 App（Tone 配色 + 修復 Unicode 解析錯誤）
 *
 * 修復點：
 * - 以前某些內容被插入了反斜線（className=\"...\"），導致 parser 把後續 /\uXXXX 誤解析。
 * - 本版移除這些反斜線，並對所有包含 /\uXXXX/ 的正則加上 unicode flag `u`；範圍統一使用 \u4E00-\u9FFF。
 * - 保留/加強你要的功能：聲調配色、答對/錯視覺回饋、Enter 快捷、清單/已會/設定、貼上 2000 字等。
 */

// ------------------------------ 常量 & 型別 ------------------------------

const STORAGE_KEY = "srs2000_state_v1";
const STORAGE_DATASET_KEY = "srs2000_dataset_v1";

// 內建少量預設，避免無網路時完全沒資料。真正 2000 字建議以「自動抓取」或「貼上匯入」。
const FALLBACK_CHARS = "的一是不了在人有我他這個們中來上大為和國地到以說時要就出會可也你對生能而子那得於著下自之年過發後作里用道行所然家種事成方多經麼去法學如都同現當沒動面起看定天分還進好小部其些主樣理心她本前開但因只從想實日軍者無力它與長把機十民第公此已工使情明性知全三又關點正業外將兩高間由問很最重並物手應戰向頭文體政美相見被利什麼二等產或新己制身果加西斯".split("");

// SRS 卡片資料
export type Card = {
  c: string; // 漢字
  ease: number; // 2.5 初始
  ivl: number; // 間隔（天）
  reps: number; // 連續複習次數
  due: number; // 下一次到期（time ms）
  new: boolean; // 是否為未學新卡
  skip?: boolean; // 已會/略過
};

// App 全局狀態
export type AppState = {
  cards: Record<string, Card>;
  order: string[]; // 題庫順序（頻率由高到低）
  dailyNewLimit: number; // 每日新卡上限
  learnedTodayKey: string; // e.g. 2025-10-16
  learnedTodayCount: number;
};

// ------------------------------ 工具函式 ------------------------------

const todayKey = () => new Date().toISOString().slice(0, 10);

function loadState(): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveState(s: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function loadDataset(): string[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_DATASET_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function saveDataset(list: string[]) {
  localStorage.setItem(STORAGE_DATASET_KEY, JSON.stringify(list));
}

// pinyin-pro：數字調，例：我 → "wo3"
function getNumberedPinyin(hz: string): string {
  try {
    const py = pinyin(hz, { toneType: "num", type: "array", nonZh: "spaced" });
    const joined = Array.isArray(py) ? py.join(" ") : String(py);
    return joined
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .map((s) => s.replace(/[^a-z0-9]/gi, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

// ----- Tone color helpers -----
function splitPinyinTokens(py: string): string[] {
  return py.trim().split(/\s+/).filter(Boolean);
}

function toneColorClass(tok: string): string {
  const m = tok.match(/([1-4])$/);
  const t = m ? m[1] : "";
  switch (t) {
    case "1":
      return "text-red-600";     // 1st tone → red
    case "2":
      return "text-orange-500";  // 2nd tone → orange
    case "3":
      return "text-green-600";   // 3rd tone → green
    case "4":
      return "text-blue-600";    // 4th tone → blue
    default:
      return "text-slate-700";
  }
}

function TonePinyin({ py }: { py: string }) {
  const toks = splitPinyinTokens(py);
  return (
    <span className="font-mono font-semibold tracking-tight">
      {toks.map((tok, i) => (
        <span key={i} className={toneColorClass(tok)}>
          {tok}{i < toks.length - 1 ? " " : ""}
        </span>
      ))}
    </span>
  );
}

function initCard(char: string): Card {
  return {
    c: char,
    ease: 2.5,
    ivl: 0,
    reps: 0,
    due: Date.now(),
    new: true,
  };
}

// SM-2 簡化版，評分 1=Hard, 2=Good, 3=Easy
function review(card: Card, rating: 1 | 2 | 3): Card {
  const now = Date.now();
  const next = { ...card };
  if (rating === 1) {
    next.ease = Math.max(1.3, next.ease - 0.2);
    next.reps = 0;
    next.ivl = 1; // 明天再見
  } else {
    if (card.reps === 0) {
      next.ivl = rating === 3 ? 3 : 1;
    } else if (card.reps === 1) {
      next.ivl = rating === 3 ? 6 : 3;
    } else {
      next.ivl = Math.round(next.ivl * next.ease * (rating === 3 ? 1.15 : 1));
    }
    next.reps = card.reps + 1;
    next.ease = Math.max(1.3, next.ease + (rating === 3 ? 0.15 : 0));
  }
  next.due = now + next.ivl * 24 * 60 * 60 * 1000;
  next.new = false;
  return next;
}

// 從題庫挑出下一題：到期卡優先 → 未學新卡（受每日上限控制）
function pickNext(state: AppState): string | null {
  const now = Date.now();
  const due = state.order.filter((c) => {
    const card = state.cards[c];
    if (!card || card.skip) return false;
    return card.due <= now && !card.new; // 舊卡到期
  });
  if (due.length > 0) return due[0];

  const canNew = state.learnedTodayKey === todayKey()
    ? state.learnedTodayCount < state.dailyNewLimit
    : true;

  if (canNew) {
    const nextNew = state.order.find((c) => {
      const card = state.cards[c];
      return card && !card.skip && card.new;
    });
    if (nextNew) return nextNew;
  }

  return null;
}

function formatDue(ms: number) {
  const d = Math.round((ms - Date.now()) / (24 * 3600 * 1000));
  if (d <= 0) return "今天";
  if (d === 1) return "明天";
  return `${d}天後`;
}

// 嘗試抓取 HanziCraft 頻率表（前 2000）
async function fetchHanziCraft2000(): Promise<string[]> {
  try {
    const url = "https://hanzicraft.com/lists/frequency";
    const html = await fetch(url).then((r) => r.text());
    const div = document.createElement("div");
    div.innerHTML = html;
    const links = Array.from(div.querySelectorAll("a.hanzi"));
    const chars = links.map((a) => a.textContent?.trim() || "").filter(Boolean);
    const textAll = div.textContent || "";
    if (chars.length < 500) {
      // 使用 `u` flag，避免 parser 對 \uXXXX 範圍誤判
      const uniq = Array.from(new Set(textAll.replace(/[^\u4E00-\u9FFF]/gu, "")));
      return uniq.slice(0, 2000);
    }
    return Array.from(new Set(chars)).slice(0, 2000);
  } catch (e) {
    return [];
  }
}

// ------------------------------ 主元件 ------------------------------

export default function App() {
  const [state, setState] = useState<AppState>(() => {
    const loaded = loadState();
    if (loaded) {
      const tk = todayKey();
      if (loaded.learnedTodayKey !== tk) {
        loaded.learnedTodayKey = tk;
        loaded.learnedTodayCount = 0;
      }
      return loaded;
    }
    const dataset = loadDataset() || FALLBACK_CHARS;
    const cards: Record<string, Card> = {};
    for (const c of dataset) cards[c] = initCard(c);
    return {
      cards,
      order: dataset,
      dailyNewLimit: 30,
      learnedTodayKey: todayKey(),
      learnedTodayCount: 0,
    };
  });

  const [tab, setTab] = useState("review");
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<"typing" | "showing">("typing");
  const [lastCorrect, setLastCorrect] = useState<boolean | null>(null);
  const [autoLoaded, setAutoLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      if (autoLoaded) return;
      const ds = loadDataset();
      if (ds && ds.length >= 1000) return;
      const fetched = await fetchHanziCraft2000();
      if (fetched.length >= 1000) {
        saveDataset(fetched);
        setState((s) => {
          const cards: Record<string, Card> = {};
          for (const c of fetched) cards[c] = s.cards[c] ?? initCard(c);
          return { ...s, order: fetched, cards };
        });
      }
      setAutoLoaded(true);
    })();
  }, [autoLoaded]);

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    setCurrentId((id) => {
      if (id && state.cards[id] && !state.cards[id].skip) return id;
      return pickNext(state);
    });
  }, [state.learnedTodayCount, state.order, state.cards]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (!currentId) return;
      e.preventDefault();
      if (phase === "typing") {
        judgeAnswer();
      } else {
        nextCard();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, currentId, input, state]);

  const curr = currentId ? state.cards[currentId] : null;
  const correctPinyin = useMemo(() => (curr ? getNumberedPinyin(curr.c) : ""), [curr?.c]);

  function normalizePY(s: string) {
    return s
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function judgeAnswer() {
    if (!curr) return;
    const user = normalizePY(input);
    const answer = normalizePY(correctPinyin);
    const multi = answer.split(" ");
    const ok = multi.some((a) => a === user);
    setLastCorrect(ok);
    const rating: 1 | 2 | 3 = ok ? 2 : 1;
    actReview(rating);
    setPhase("showing");
  }

  function nextCard() {
    setPhase("typing");
    setInput("");
    setLastCorrect(null);
    setCurrentId((_) => pickNext(state));
    inputRef.current?.focus();
  }

  function actReview(rating: 1 | 2 | 3) {
    if (!curr) return;
    setState((s) => {
      const updated = review(s.cards[curr.c], rating);
      const ns = { ...s, cards: { ...s.cards, [curr.c]: updated } };
      if (s.learnedTodayKey !== todayKey()) {
        ns.learnedTodayKey = todayKey();
        ns.learnedTodayCount = 0;
      }
      if (s.cards[curr.c].new) ns.learnedTodayCount += 1;
      return ns;
    });
  }

  function skipCurrent() {
    if (!curr) return;
    setState((s) => ({
      ...s,
      cards: { ...s.cards, [curr.c]: { ...s.cards[curr.c], skip: true } },
    }));
    nextCard();
  }

  function unskip(c: string) {
    setState((s) => ({
      ...s,
      cards: { ...s.cards, [c]: { ...s.cards[c], skip: false } },
    }));
  }

  const total = state.order.length;
  const learned = state.order.filter((c) => !state.cards[c].new && !state.cards[c].skip).length;
  const skipped = state.order.filter((c) => state.cards[c].skip).length;

  // ------------------------------ UI ------------------------------

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white text-slate-900">
      <div className="max-w-4xl mx-auto p-4 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl md:text-3xl font-bold">2000字 SRS 測驗</h1>
          <div className="text-sm text-slate-500">進度：{learned}/{total}（已會 {skipped}）</div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid grid-cols-4 gap-2">
            <TabsTrigger value="review">測驗</TabsTrigger>
            <TabsTrigger value="list">清單</TabsTrigger>
            <TabsTrigger value="known">已會</TabsTrigger>
            <TabsTrigger value="settings">設定</TabsTrigger>
          </TabsList>

          {/* 測驗 */}
          <TabsContent value="review">
            <Card className="mt-4">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Info className="w-4 h-4" /> 按 Enter 判分；再次 Enter 進下一題
                </CardTitle>
                <Badge variant="outline">每日新卡上限：{state.dailyNewLimit}</Badge>
              </CardHeader>
              <CardContent>
                {curr ? (
                  <div className="space-y-6">
                    <div className="flex items-center justify-center">
                      <motion.div
                        key={curr.c + phase}
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="text-7xl md:text-8xl font-semibold leading-none p-6"
                      >
                        {curr.c}
                      </motion.div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-center">
                      <Input
                        ref={inputRef}
                        placeholder="輸入拼音（數字調，如 wo3）後按 Enter"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        className={
                          "h-12 text-lg " +
                          (phase === "showing"
                            ? lastCorrect
                              ? "border-green-500 ring-1 ring-green-300"
                              : "border-red-500 ring-1 ring-red-300"
                            : "")
                        }
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <Button variant="outline" onClick={() => setPhase("showing")}>
                          顯示答案
                        </Button>
                        <Button variant="secondary" onClick={skipCurrent}>
                          <SkipForward className="w-4 h-4 mr-1" /> 已會/略過
                        </Button>
                      </div>
                    </div>

                    {phase === "showing" && (
                      <Alert>
                        <AlertTitle>正確拼音</AlertTitle>
                        <AlertDescription>
                          {lastCorrect ? (
                            <div className="flex items-center gap-3">
                              <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-2xl">✅ 正確</motion.div>
                              <TonePinyin py={correctPinyin || ""} />
                            </div>
                          ) : (
                            <div>
                              <div className="text-sm text-slate-600 mb-1">正確拼音</div>
                              <TonePinyin py={correctPinyin || ""} />
                            </div>
                          )}
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button onClick={() => { actReview(1); nextCard(); }}>Hard</Button>
                            <Button onClick={() => { actReview(2); nextCard(); }} variant="secondary">Good</Button>
                            <Button onClick={() => { actReview(3); nextCard(); }} variant="default">Easy</Button>
                          </div>
                        </AlertDescription>
                      </Alert>
                    )}

                    <Progress value={(learned / Math.max(1, total)) * 100} />
                  </div>
                ) : (
                  <div className="text-center py-16 space-y-4">
                    <div className="text-2xl font-semibold">目前沒有到期卡囉</div>
                    <div className="text-slate-500">等卡片到期，或在「設定」放寬每日新卡上限，或在「清單」手動挑題練習。</div>
                    <div>
                      <Button onClick={() => setTab("list")} variant="secondary">
                        <ListFilter className="w-4 h-4 mr-1" /> 前往清單
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* 清單 */}
          <TabsContent value="list">
            <ListView state={state} setState={setState} unskip={unskip} />
          </TabsContent>

          {/* 已會 */}
          <TabsContent value="known">
            <KnownView state={state} setState={setState} />
          </TabsContent>

          {/* 設定 */}
          <TabsContent value="settings">
            <SettingsView state={state} setState={setState} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// ------------------------------ 子元件：清單 ------------------------------

function ListView({ state, setState, unskip }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>>; unskip: (c: string) => void; }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const arr = state.order.filter((c) => !state.cards[c].skip);
    if (!q.trim()) return arr;
    return arr.filter((c) => c.includes(q.trim()));
  }, [q, state.order, state.cards]);

  function studyNow(c: string) {
    setState((s) => {
      const card = s.cards[c];
      const updated = { ...card, due: Date.now(), new: false };
      return { ...s, cards: { ...s.cards, [c]: updated } };
    });
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>2000 字總表（可搜尋 / 管理）</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2 mb-3">
          <Input placeholder="搜尋單字…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ScrollArea className="h-[60vh] rounded border p-2">
          <div className="grid grid-cols-8 md:grid-cols-12 gap-2">
            {filtered.map((c) => {
              const card = state.cards[c];
              const py = getNumberedPinyin(c);
              return (
                <div key={c} className="border rounded-xl p-2 text-center group">
                  <div className="text-2xl leading-none">{c}</div>
                  <div className="text-[10px] text-slate-500 mt-1"><TonePinyin py={py} /></div>
                  <div className="flex items-center justify-center gap-1 mt-2">
                    {!card.new && <Badge variant="secondary">在學</Badge>}
                    {card.new && <Badge variant="outline">新</Badge>}
                    <Badge variant="outline">{formatDue(card.due)}</Badge>
                  </div>
                  <div className="flex gap-1 mt-2">
                    <Button size="sm" className="w-full" onClick={() => studyNow(c)}>加入今日</Button>
                    <Button size="sm" variant="secondary" onClick={() => unskip(c)} disabled={!card.skip}>
                      取消略過
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// ------------------------------ 子元件：已會 ------------------------------

function KnownView({ state, setState }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>>; }) {
  const known = state.order.filter((c) => state.cards[c].skip);
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    if (!q.trim()) return known;
    return known.filter((c) => c.includes(q.trim()));
  }, [q, known]);

  function unskip(c: string) {
    setState((s) => ({ ...s, cards: { ...s.cards, [c]: { ...s.cards[c], skip: false } } }));
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>已會/略過 清單</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2 mb-3">
          <Input placeholder="搜尋單字…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ScrollArea className="h-[60vh] rounded border p-2">
          {list.length === 0 ? (
            <div className="text-center text-slate-500 py-10">還沒有任何已會/略過的字</div>
          ) : (
            <div className="grid grid-cols-8 md:grid-cols-12 gap-2">
              {list.map((c) => (
                <div key={c} className="border rounded-xl p-2 text-center">
                  <div className="text-2xl leading-none">{c}</div>
                  <div className="text-[10px] text-slate-500 mt-1"><TonePinyin py={getNumberedPinyin(c)} /></div>
                  <Button size="sm" className="w-full mt-2" variant="secondary" onClick={() => unskip(c)}>
                    取消略過
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

// ------------------------------ 子元件：設定（含自動化測試） ------------------------------

function SettingsView({ state, setState }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>>; }) {
  const [daily, setDaily] = useState(String(state.dailyNewLimit));
  const [paste, setPaste] = useState("");
  const [info, setInfo] = useState<string>("");

  function applyDaily() {
    const n = Math.max(0, Math.min(200, parseInt(daily || "0")));
    setState((s) => ({ ...s, dailyNewLimit: n }));
  }

  function resetAll() {
    if (!confirm("確定要重置進度嗎？此操作無法還原")) return;
    const ds = loadDataset() || FALLBACK_CHARS;
    const cards: Record<string, Card> = {};
    for (const c of ds) cards[c] = initCard(c);
    setState({
      cards,
      order: ds,
      dailyNewLimit: 30,
      learnedTodayKey: todayKey(),
      learnedTodayCount: 0,
    });
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `SRS2000_${todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJSON(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result));
        if (!obj.cards || !obj.order) throw new Error("格式不符");
        setState(obj);
        setInfo("已匯入進度");
      } catch (err) {
        setInfo("匯入失敗：檔案格式錯誤");
      }
    };
    reader.readAsText(file);
  }

  function applyPasteList() {
    // 使用 Unicode flag `u`，安全處理中文字範圍
    const raw = paste.replace(/[^\u4E00-\u9FFF\s,，]/gu, " ");
    const arr = Array.from(new Set(raw.replace(/[，,]/gu, " ").split(/\s+/).join("").split("")))
      .filter(Boolean)
      .slice(0, 2000);
    if (arr.length < 10) {
      setInfo("清單太短，請至少貼入 10 個漢字");
      return;
    }
    saveDataset(arr);
    setState((s) => {
      const cards: Record<string, Card> = { ...s.cards };
      for (const c of arr) cards[c] = cards[c] ?? initCard(c);
      return { ...s, order: arr, cards };
    });
    setInfo(`已更新資料集，共 ${arr.length} 字`);
  }

  // —— 內建小測試（不改動你的功能，僅顯示在設定頁）——
  const tests = useMemo(() => runSelfTests(), []);

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>設定 & 資料管理</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="mb-2 text-sm text-slate-600">每日新卡上限</div>
            <div className="flex gap-2 items-center">
              <Input value={daily} onChange={(e) => setDaily(e.target.value)} className="w-24" />
              <Button onClick={applyDaily}>套用</Button>
            </div>
          </div>
          <div className="flex items-end gap-2">
            <Button onClick={exportJSON}>
              <Download className="w-4 h-4 mr-1" /> 匯出進度
            </Button>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <Upload className="w-4 h-4" />
              <input type="file" accept="application/json" className="hidden" onChange={importJSON} />
              <span className="underline">匯入進度</span>
            </label>
            <Button variant="destructive" onClick={resetAll}>
              <RotateCcw className="w-4 h-4 mr-1" /> 重置全部
            </Button>
          </div>
        </div>

        <Alert>
          <AlertTitle>資料集來源</AlertTitle>
          <AlertDescription>
            預設會嘗試自動抓取 HanziCraft 頻率表（若瀏覽器阻擋，請改用底下「貼上清單」）。
          </AlertDescription>
        </Alert>

        <div>
          <div className="mb-2 text-sm text-slate-600">貼上你的 2000 字（可逗號/空白/換行分隔）</div>
          <Textarea rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="例：的一是不了在人有…" />
          <div className="mt-2 flex gap-2">
            <Button onClick={applyPasteList}>套用清單</Button>
          </div>
        </div>

        {/* 測試區（只讀） */}
        <div className="rounded-xl border p-3">
          <div className="font-semibold mb-2">內建測試</div>
          <ul className="list-disc ml-5 text-sm">
            {tests.map((t, i) => (
              <li key={i} className={t.pass ? "text-green-700" : "text-red-700"}>
                {t.name}: {t.pass ? "PASS" : `FAIL → ${t.message}`}
              </li>
            ))}
          </ul>
        </div>

        {info && <div className="text-green-700 text-sm">{info}</div>}
      </CardContent>
    </Card>
  );
}

// ------------------------------ 測試用函式 ------------------------------

type TestResult = { name: string; pass: boolean; message?: string };

function runSelfTests(): TestResult[] {
  const results: TestResult[] = [];

  // 1) 拼音數字調
  const p1 = getNumberedPinyin("我");
  results.push({ name: "pinyin wo3", pass: p1 === "wo3", message: `got ${p1}` });

  // 2) Tone 顏色分類
  const colors = ["ma1", "ma2", "ma3", "ma4"].map(toneColorClass);
  results.push({ name: "tone colors order", pass: colors[0].includes("red") && colors[3].includes("blue"), message: colors.join(",") });

  // 3) Unicode 正則：只保留中日韓統一表意文字
  const kept = "ABC一二三😊".replace(/[^\u4E00-\u9FFF]/gu, "");
  results.push({ name: "unicode regex keep CJK", pass: kept === "一二三", message: kept });

  return results;
}
