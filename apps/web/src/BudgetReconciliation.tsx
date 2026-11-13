import { useCallback, useEffect, useState } from "react";
import { request } from "./api";

type Reservation = {
  id: number;
  account_id: string;
  task_id?: number;
  estimate_micros: number;
  estimate_basis?: string;
  created_at?: string;
};
export function BudgetReconciliation({
  onChange,
}: {
  onChange: () => Promise<void>;
}) {
  const [items, setItems] = useState<Reservation[]>([]);
  const [edits, setEdits] = useState<
    Record<number, { actual: string; evidence: string }>
  >({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(
        await request<Reservation[]>("/budget-reservations?status=unknown"),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function reconcile(id: number) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`/budget-reservations/${id}/reconcile`, {
        actual_micros: Number(edits[id].actual),
        evidence: edits[id].evidence,
      });
      await load();
      await onChange();
      setNotice("预算已按实际费用与证据对账。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <h3>未知费用预算对账</h3>
      <button
        disabled={busy || loading}
        onClick={() => {
          setError("");
          void load();
        }}
      >
        刷新未知预算
      </button>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="alert success">
          {notice}
        </p>
      )}
      {loading && <p role="status">正在读取未知预算…</p>}
      {!loading && !items.length && !error && (
        <p className="empty">暂无未知费用预留</p>
      )}
      {items.map((item) => {
        const edit = edits[item.id] ?? { actual: "", evidence: "" };
        return (
          <form
            className="artifact"
            key={item.id}
            onSubmit={(e) => {
              e.preventDefault();
              void reconcile(item.id);
            }}
          >
            <strong>
              预留 #{item.id} · 账户 {item.account_id}
            </strong>
            <p>
              任务 {item.task_id ?? "—"} · 估算 {item.estimate_micros} 微单位
            </p>
            <p>{item.estimate_basis}</p>
            <label>
              实际费用（微单位）
              <input
                type="number"
                min={0}
                max={10 ** 15}
                step={1}
                required
                value={edit.actual}
                onChange={(e) =>
                  setEdits({
                    ...edits,
                    [item.id]: { ...edit, actual: e.target.value },
                  })
                }
              />
            </label>
            <label>
              实际费用依据
              <textarea
                required
                maxLength={2000}
                value={edit.evidence}
                onChange={(e) =>
                  setEdits({
                    ...edits,
                    [item.id]: { ...edit, evidence: e.target.value },
                  })
                }
              />
            </label>
            <button
              disabled={busy || edit.actual === "" || !edit.evidence.trim()}
            >
              提交预算对账 {item.id}
            </button>
          </form>
        );
      })}
    </div>
  );
}
