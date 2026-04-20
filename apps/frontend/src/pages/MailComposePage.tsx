/**
 * MailComposePage
 *
 * jobId / divisionCode 를 state 또는 query param 으로 받아
 * 메일 초안을 자동 생성하거나 기존 초안을 불러온 뒤 편집·저장합니다.
 *
 * 레이아웃:
 *   - 좌 2/3 : 수신자·참조·제목·본문 편집 폼
 *   - 우 1/3 : 수신자 그룹 패널 (본부 기본 수신자 관리)
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
} from "react";
import { useLocation, useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { useToast } from "../components/common";
import { LoadingSpinner } from "../components/common";

// ── API 타입 ─────────────────────────────────────────────────────────────────

interface DraftRow {
  id:            string;
  report_job_id: string;
  recipients:    string[];
  cc:            string[];
  subject:       string;
  body_html:     string;
  created_at:    string;
  updated_at:    string;
}

interface RecipientGroup {
  id:            string;
  division_code: string;
  name:          string;
  emails:        string[];
  created_at:    string;
}

interface ApiListResponse<T> {
  data: { items: T[]; total: number };
}

interface ApiOkResponse<T> {
  data: T;
}

// ── 이메일 태그 입력 컴포넌트 ─────────────────────────────────────────────────

interface TagInputProps {
  label:     string;
  tags:      string[];
  onChange:  (tags: string[]) => void;
  disabled?: boolean;
}

function TagInput({ label, tags, onChange, disabled }: TagInputProps) {
  const [inputVal, setInputVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = useCallback(
    (raw: string) => {
      const emails = raw
        .split(/[,;\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !tags.includes(e));
      if (emails.length) onChange([...tags, ...emails]);
      setInputVal("");
    },
    [tags, onChange]
  );

  const removeTag = useCallback(
    (email: string) => onChange(tags.filter((t) => t !== email)),
    [tags, onChange]
  );

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (["Enter", ",", "Tab"].includes(e.key)) {
      e.preventDefault();
      if (inputVal.trim()) addTag(inputVal);
    } else if (e.key === "Backspace" && !inputVal && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div
        className="min-h-[42px] flex flex-wrap gap-1.5 p-1.5 border border-gray-300 rounded-lg bg-white cursor-text focus-within:ring-2 focus-within:ring-primary-500 focus-within:border-primary-500"
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((email) => (
          <span
            key={email}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary-100 text-primary-800 text-sm"
          >
            {email}
            {!disabled && (
              <button
                type="button"
                onClick={() => removeTag(email)}
                className="text-primary-500 hover:text-primary-700 leading-none"
              >
                ×
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <input
            ref={inputRef}
            type="text"
            value={inputVal}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setInputVal(e.target.value)}
            onKeyDown={handleKey}
            onBlur={() => { if (inputVal.trim()) addTag(inputVal); }}
            placeholder={tags.length ? "" : "이메일 입력 후 Enter"}
            className="flex-1 min-w-[160px] outline-none text-sm py-0.5 px-1 bg-transparent"
          />
        )}
      </div>
    </div>
  );
}

// ── 수신자 그룹 패널 ──────────────────────────────────────────────────────────

interface GroupPanelProps {
  divisionCode: string;
  onApply:      (emails: string[]) => void;
}

interface GroupFormState {
  name:   string;
  emails: string;
}

function GroupPanel({ divisionCode, onApply }: GroupPanelProps) {
  const { success, error } = useToast();
  const qc = useQueryClient();
  const [showForm, setShowForm]   = useState(false);
  const [editId,   setEditId]     = useState<string | null>(null);
  const [form,     setForm]       = useState<GroupFormState>({ name: "", emails: "" });

  const { data: groups = [] as RecipientGroup[], isLoading } = useQuery({
    queryKey: ["mail", "groups", divisionCode],
    queryFn: async () => {
      const res = await apiClient.get<ApiOkResponse<RecipientGroup[]>>(
        `/api/mail/groups?division=${divisionCode}`
      );
      return res.data.data;
    },
  });

  const createMut = useMutation({
    mutationFn: (d: { name: string; emails: string[] }) =>
      apiClient.post("/api/mail/groups", { division_code: divisionCode, ...d }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mail", "groups", divisionCode] });
      success("그룹이 생성되었습니다.");
      setShowForm(false);
      setForm({ name: "", emails: "" });
    },
    onError: () => error("그룹 생성에 실패했습니다."),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, ...d }: { id: string; name: string; emails: string[] }) =>
      apiClient.put(`/api/mail/groups/${id}`, d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mail", "groups", divisionCode] });
      success("그룹이 수정되었습니다.");
      setEditId(null);
      setForm({ name: "", emails: "" });
    },
    onError: () => error("그룹 수정에 실패했습니다."),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/mail/groups/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mail", "groups", divisionCode] });
      success("그룹이 삭제되었습니다.");
    },
    onError: () => error("그룹 삭제에 실패했습니다."),
  });

  const startEdit = (g: RecipientGroup) => {
    setEditId(g.id);
    setForm({ name: g.name, emails: g.emails.join(", ") });
    setShowForm(true);
  };

  const handleSubmit = () => {
    const emails = form.emails
      .split(/[,;\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

    if (!form.name.trim()) return;
    if (editId) {
      updateMut.mutate({ id: editId, name: form.name, emails });
    } else {
      createMut.mutate({ name: form.name, emails });
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditId(null);
    setForm({ name: "", emails: "" });
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-800">수신자 그룹</h3>
        <button
          onClick={() => { setShowForm(true); setEditId(null); setForm({ name: "", emails: "" }); }}
          className="text-xs px-2 py-1 rounded bg-primary-600 text-white hover:bg-primary-700"
        >
          + 추가
        </button>
      </div>

      {isLoading && <LoadingSpinner centered label="로딩 중..." />}

      {!isLoading && groups.length === 0 && (
        <p className="text-sm text-gray-400">등록된 그룹이 없습니다.</p>
      )}

      {groups.map((g: RecipientGroup) => (
        <div key={g.id} className="border border-gray-100 rounded-lg p-3 space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm font-medium text-gray-800">{g.name}</span>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => startEdit(g)}
                className="text-xs text-gray-500 hover:text-primary-600 px-1"
              >
                편집
              </button>
              <button
                onClick={() => deleteMut.mutate(g.id)}
                className="text-xs text-gray-500 hover:text-red-600 px-1"
              >
                삭제
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {g.emails.map((e: string) => (
              <span key={e} className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                {e}
              </span>
            ))}
          </div>
          <button
            onClick={() => onApply(g.emails)}
            className="w-full text-xs py-1 rounded border border-primary-300 text-primary-700 hover:bg-primary-50 mt-1"
          >
            수신자에 추가
          </button>
        </div>
      ))}

      {showForm && (
        <div className="border border-primary-200 rounded-lg p-3 space-y-2 bg-primary-50">
          <p className="text-xs font-medium text-primary-800">
            {editId ? "그룹 수정" : "새 그룹"}
          </p>
          <input
            type="text"
            placeholder="그룹 이름"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary-500"
          />
          <textarea
            placeholder="이메일 주소 (쉼표/줄바꿈 구분)"
            value={form.emails}
            onChange={(e) => setForm((f) => ({ ...f, emails: e.target.value }))}
            rows={3}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary-500 resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={createMut.isPending || updateMut.isPending}
              className="flex-1 text-xs py-1.5 rounded bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {editId ? "저장" : "생성"}
            </button>
            <button
              onClick={handleCancel}
              className="flex-1 text-xs py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── HTML 미리보기 / 편집기 ────────────────────────────────────────────────────

interface BodyEditorProps {
  value:    string;
  onChange: (val: string) => void;
}

function BodyEditor({ value, onChange }: BodyEditorProps) {
  const [mode, setMode] = useState<"preview" | "source">("preview");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-700">본문</label>
        <div className="flex rounded-lg overflow-hidden border border-gray-200 text-xs">
          <button
            type="button"
            onClick={() => setMode("preview")}
            className={`px-3 py-1 ${mode === "preview" ? "bg-primary-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
          >
            미리보기
          </button>
          <button
            type="button"
            onClick={() => setMode("source")}
            className={`px-3 py-1 ${mode === "source" ? "bg-primary-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
          >
            HTML 편집
          </button>
        </div>
      </div>

      {mode === "preview" ? (
        <div
          className="min-h-[400px] border border-gray-200 rounded-lg p-4 bg-white overflow-auto prose prose-sm max-w-none"
          dangerouslySetInnerHTML={{ __html: value }}
        />
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={20}
          spellCheck={false}
          className="font-mono text-xs border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500 resize-y"
        />
      )}
    </div>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────────────────

export function MailComposePage() {
  const location       = useLocation();
  const [searchParams] = useSearchParams();
  const navigate       = useNavigate();
  const { success, error: toastError } = useToast();
  const qc             = useQueryClient();

  // jobId / divisionCode 추출
  const stateJobId  = (location.state as { jobId?: string } | null)?.jobId ?? null;
  const stateDivCode = (location.state as { divisionCode?: string } | null)?.divisionCode ?? null;
  const paramJobId  = searchParams.get("jobId");
  const jobId       = stateJobId ?? paramJobId ?? null;
  const divisionCode = stateDivCode ?? searchParams.get("divisionCode") ?? "";

  // 드래프트 목록 조회 (기존 초안 확인용)
  const draftsQuery = useQuery({
    queryKey: ["mail", "drafts", jobId],
    queryFn: async () => {
      if (!jobId) return { items: [], total: 0 };
      const res = await apiClient.get<ApiListResponse<DraftRow>>(
        `/api/mail/draft?jobId=${jobId}&limit=1`
      );
      return res.data.data;
    },
    enabled: !!jobId,
  });

  const existingDraft: DraftRow | null = draftsQuery.data?.items[0] ?? null;

  // 자동 초안 생성
  const generateMut = useMutation({
    mutationFn: () =>
      apiClient.post<ApiOkResponse<DraftRow>>("/api/mail/draft", { jobId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mail", "drafts", jobId] });
    },
    onError: () => toastError("메일 초안 자동 생성에 실패했습니다."),
  });

  // 초안이 없을 때 자동 생성 트리거
  const autoGenRef = useRef(false);
  useEffect(() => {
    if (
      !autoGenRef.current &&
      !draftsQuery.isLoading &&
      !existingDraft &&
      jobId &&
      !generateMut.isPending &&
      !generateMut.isSuccess &&
      !generateMut.isError
    ) {
      autoGenRef.current = true;
      generateMut.mutate();
    }
  }, [draftsQuery.isLoading, existingDraft, jobId, generateMut]);

  // 폼 상태
  const [recipients, setRecipients] = useState<string[]>([]);
  const [cc,         setCc]         = useState<string[]>([]);
  const [subject,    setSubject]    = useState("");
  const [bodyHtml,   setBodyHtml]   = useState("");
  const [draftId,    setDraftId]    = useState<string | null>(null);
  const [dirty,      setDirty]      = useState(false);

  // 초안 로드 → 폼에 반영
  useEffect(() => {
    if (existingDraft && !dirty) {
      setDraftId(existingDraft.id);
      setRecipients(existingDraft.recipients);
      setCc(existingDraft.cc);
      setSubject(existingDraft.subject);
      setBodyHtml(existingDraft.body_html);
    }
  }, [existingDraft, dirty]);

  // 초안 저장
  const saveMut = useMutation({
    mutationFn: () => {
      if (!draftId) throw new Error("초안 ID 없음");
      return apiClient.put<ApiOkResponse<DraftRow>>(`/api/mail/draft/${draftId}`, {
        recipients,
        cc,
        subject,
        body_html: bodyHtml,
      });
    },
    onSuccess: (res: import("axios").AxiosResponse<ApiOkResponse<DraftRow>>) => {
      const updated = res.data.data;
      setDraftId(updated.id);
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["mail", "drafts", jobId] });
      success("메일 초안이 저장되었습니다.");
    },
    onError: () => toastError("저장에 실패했습니다."),
  });

  // 수신자 그룹 이메일 추가
  const handleApplyGroup = (emails: string[]) => {
    const next = [...new Set([...recipients, ...emails])];
    setRecipients(next);
    setDirty(true);
  };

  // mailto 링크 생성
  const openMailto = () => {
    const to  = recipients.join(",");
    const ccStr = cc.join(",");
    const sub = encodeURIComponent(subject);
    const body = encodeURIComponent(
      bodyHtml.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
    );
    const href = `mailto:${to}?cc=${ccStr}&subject=${sub}&body=${body}`;
    window.open(href, "_blank");
  };

  const isLoading = draftsQuery.isLoading || generateMut.isPending;
  const hasNoDraft = !isLoading && !existingDraft && (generateMut.isError);

  if (!jobId) {
    return (
      <div className="p-8 text-center">
        <p className="text-gray-500">jobId 가 없습니다. 보고서 생성 페이지에서 이동해 주세요.</p>
        <button
          onClick={() => navigate("/dashboard")}
          className="mt-4 px-4 py-2 rounded-lg bg-primary-600 text-white text-sm hover:bg-primary-700"
        >
          대시보드로
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">메일 초안 작성</h1>
          {divisionCode && (
            <p className="text-sm text-gray-500 mt-0.5">{divisionCode} 보고서 메일</p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => navigate(-1)}
            className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm hover:bg-gray-50"
          >
            뒤로
          </button>
          <button
            onClick={openMailto}
            disabled={!draftId || recipients.length === 0}
            className="px-4 py-2 rounded-lg border border-secondary-300 text-secondary-700 text-sm hover:bg-secondary-50 disabled:opacity-40"
          >
            메일 클라이언트로 열기
          </button>
          <button
            onClick={() => saveMut.mutate()}
            disabled={!draftId || saveMut.isPending || !dirty}
            className="px-4 py-2 rounded-lg bg-primary-600 text-white text-sm hover:bg-primary-700 disabled:opacity-40"
          >
            {saveMut.isPending ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>

      {/* 로딩 */}
      {isLoading && (
        <div className="flex items-center justify-center h-64">
          <LoadingSpinner centered label="메일 초안 생성 중..." />
        </div>
      )}

      {/* 오류 */}
      {hasNoDraft && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
          <p className="text-red-700 font-medium">메일 초안 생성에 실패했습니다.</p>
          <button
            onClick={() => { autoGenRef.current = false; generateMut.reset(); generateMut.mutate(); }}
            className="mt-3 px-4 py-2 rounded-lg bg-red-600 text-white text-sm hover:bg-red-700"
          >
            재시도
          </button>
        </div>
      )}

      {/* 메인 편집 영역 */}
      {!isLoading && draftId && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 좌: 편집 폼 */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
              {/* 수신자 */}
              <TagInput
                label="받는 사람 (To)"
                tags={recipients}
                onChange={(t) => { setRecipients(t); setDirty(true); }}
              />

              {/* 참조 */}
              <TagInput
                label="참조 (CC)"
                tags={cc}
                onChange={(t) => { setCc(t); setDirty(true); }}
              />

              {/* 제목 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">제목</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => { setSubject(e.target.value); setDirty(true); }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>

            {/* 본문 편집기 */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <BodyEditor
                value={bodyHtml}
                onChange={(v) => { setBodyHtml(v); setDirty(true); }}
              />
            </div>

            {/* 저장 상태 표시 */}
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>
                {dirty
                  ? "저장되지 않은 변경사항이 있습니다."
                  : existingDraft
                  ? `마지막 저장: ${new Date(existingDraft.updated_at).toLocaleString("ko-KR")}`
                  : ""}
              </span>
              <button
                onClick={() => saveMut.mutate()}
                disabled={!dirty || saveMut.isPending}
                className="px-3 py-1 rounded bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-40 text-xs"
              >
                {saveMut.isPending ? "저장 중..." : "저장"}
              </button>
            </div>
          </div>

          {/* 우: 수신자 그룹 패널 */}
          <div className="space-y-4">
            {divisionCode && (
              <GroupPanel divisionCode={divisionCode} onApply={handleApplyGroup} />
            )}

            {/* 요약 정보 */}
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-2 text-sm">
              <h3 className="font-semibold text-gray-700">초안 정보</h3>
              <div className="flex justify-between text-gray-500">
                <span>받는 사람</span>
                <span className="font-medium text-gray-800">{recipients.length}명</span>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>참조</span>
                <span className="font-medium text-gray-800">{cc.length}명</span>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>Job ID</span>
                <span className="font-mono text-xs text-gray-600 max-w-[120px] truncate">{jobId}</span>
              </div>
            </div>

            {/* 도움말 */}
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-700 space-y-1.5">
              <p className="font-medium">사용 방법</p>
              <ul className="list-disc list-inside space-y-0.5 text-blue-600">
                <li>이메일 입력 후 Enter 또는 쉼표로 추가</li>
                <li>그룹 "수신자에 추가" 클릭으로 일괄 추가</li>
                <li>HTML 편집 탭에서 본문 소스 수정 가능</li>
                <li>저장 후 메일 클라이언트로 열기 가능</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
