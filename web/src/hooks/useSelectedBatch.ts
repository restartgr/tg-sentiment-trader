import { useCallback, useState } from "react";

function readBatchParam() {
  const id = Number(new URLSearchParams(window.location.search).get("batch"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function writeBatchParam(id: number | null) {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete("batch");
  else url.searchParams.set("batch", String(id));
  history.replaceState(null, "", url);
}

// 打开的批次同步到 URL，刷新或分享链接时能直接定位
export function useSelectedBatch() {
  const [selectedId, setSelectedId] = useState(readBatchParam);

  const openBatch = useCallback((id: number) => {
    writeBatchParam(id);
    setSelectedId(id);
  }, []);

  const closeBatch = useCallback(() => {
    writeBatchParam(null);
    setSelectedId(null);
  }, []);

  return { selectedId, openBatch, closeBatch };
}
