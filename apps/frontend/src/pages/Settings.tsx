/**
 * Settings — 관리자 전용 설정 페이지 (role=admin)
 *
 * 탭 1 · 시스템 연동 설정  GET/PATCH /api/admin/divisions/:id/config
 * 탭 2 · 캡처 설정         GET/PUT/PATCH /api/admin/divisions/:id/screenshot-config
 * 탭 3 · 수신자 그룹 관리  GET/POST/PUT/DELETE /api/mail/groups
 * 탭 4 · 사용자 관리       GET/POST/PATCH/DELETE /api/admin/users
 */

import {
  useState,
  type ReactNode,
  type ChangeEvent,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { AppLayout, useToast, LoadingSpinner, StatusBadge } from "../components/common";

// ── 공통 상수 ─────────────────────────────────────────────────────────────────

// id 는 schema.sql 초기 데이터의 고정 UUID (ON CONFLICT DO NOTHING으로 항상 동일)
const DIVISIONS = [
  { id: "a1000000-0000-0000-0000-000000000001", code: "BIO",    name: "Bio연구본부" },
  { id: "a2000000-0000-0000-0000-000000000002", code: "DEV",    name: "개발본부" },
  { id: "a3000000-0000-0000-0000-000000000003", code: "LHOUSE", name: "L HOUSE 공장" },
] as const;

type DivisionId = typeof DIVISIONS[number]["id"];

const SYSTEMS_BY_DIVISION: Record<string, { code: string; label: string }[]> = {
  BIO:    [
    { code: "EDMS",      label: "eDMS" },
    { code: "ELN",       label: "ELN" },
    { code: "GCLP_LIMS", label: "GCLP LIMS" },
  ],
  DEV:    [
    { code: "EQMS",     label: "eQMS" },
    { code: "EDMS",     label: "eDMS" },
    { code: "ELMS",     label: "eLMS" },
    { code: "CTMS",     label: "CTMS" },
    { code: "ETMF",     label: "eTMF" },
    { code: "MEDCOMMS", label: "Medcomms" },
  ],
  LHOUSE: [
    { code: "EQMS", label: "eQMS" },
    { code: "EDMS", label: "eDMS" },
    { code: "ELMS", label: "eLMS" },
  ],
};

const ROLES = ["admin", "manager", "viewer"] as const;
type UserRole = typeof ROLES[number];

// ── 공통 타입 ─────────────────────────────────────────────────────────────────

interface ApiOk<T>   { data: T }
interface ApiPaged<T>{ data: { items: T[]; total: number } }

interface ScreenshotTarget {
  systemName:        string;
  label:             string;
  urlPath:           string;
  selector:          string | null;
  waitForSelector:   string | null;
  description:       string;
  captureAfterLogin: true;
}

interface DivisionScreenshotConfig {
  divisionCode: string;
  targets:      ScreenshotTarget[];
}

interface RecipientGroup {
  id:            string;
  division_code: string;
  name:          string;
  emails:        string[];
  created_at:    string;
}

interface UserRow {
  id:            string;
  email:         string;
  name:          string;
  role:          UserRole;
  division_code: string | null;
  division_name: string | null;
  created_at:    string;
}

// ── 공통 UI ───────────────────────────────────────────────────────────────────

function SectionCard({ title, subtitle, action, children }: {
  title:    string;
  subtitle?: string;
  action?:  ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
          {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <label className="w-36 shrink-0 text-xs font-medium text-gray-500 pt-2">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function TextInput({ value, onChange, placeholder, type = "text", disabled }: {
  value:       string;
  onChange:    (v: string) => void;
  placeholder?: string;
  type?:       string;
  disabled?:   boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2
                 focus:outline-none focus:ring-2 focus:ring-primary-400 focus:border-primary-400
                 disabled:bg-gray-50 disabled:text-gray-400"
    />
  );
}

function DivisionSelector({ value, onChange }: {
  value:    DivisionId;
  onChange: (id: DivisionId) => void;
}) {
  return (
    <div className="flex gap-2 mb-5">
      {DIVISIONS.map((d) => (
        <button
          key={d.id}
          onClick={() => onChange(d.id)}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            value === d.id
              ? "bg-primary-600 text-white shadow-sm"
              : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
          }`}
        >
          {d.code}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 탭 1: 시스템 연동 설정
// ─────────────────────────────────────────────────────────────────────────────

interface SystemConfig {
  url:          string;
  username:     string;
  password:     string;
  downloadPath: string;
}

function SystemConnectionCard({
  code,
  label,
  divisionId,
}: {
  code:       string;
  label:      string;
  divisionId: DivisionId;
}) {
  const { success, error: toastError } = useToast();
  const [cfg, setCfg] = useState<SystemConfig>({
    url: "", username: "", password: "", downloadPath: "",
  });
  const [showPw,    setShowPw]    = useState(false);
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");

  const set = (key: keyof SystemConfig) => (v: string) =>
    setCfg((p) => ({ ...p, [key]: v }));

  const saveMut = useMutation({
    mutationFn: () =>
      apiClient.patch(`/api/admin/divisions/${divisionId}/config`, {
        systems: [{ name: code, url: cfg.url, auth: { username: cfg.username, password: cfg.password, downloadPath: cfg.downloadPath } }],
      }),
    onSuccess: () => success(`${label} 설정이 저장되었습니다.`),
    onError:   () => toastError("저장에 실패했습니다."),
  });

  const handleTest = async () => {
    setTestState("testing");
    try {
      await apiClient.post("/api/admin/test-connection", {
        divisionId, systemCode: code, url: cfg.url,
        username: cfg.username, password: cfg.password,
      });
      setTestState("ok");
      success(`${label} 연결 성공`);
    } catch {
      setTestState("fail");
      toastError(`${label} 연결 실패`);
    }
  };

  return (
    <div className="border border-gray-100 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-primary-700 bg-primary-50 px-2 py-0.5 rounded">{code}</span>
          <span className="text-sm font-medium text-gray-800">{label}</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleTest}
            disabled={testState === "testing" || !cfg.url}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-secondary-300
                       text-secondary-700 text-xs font-medium hover:bg-secondary-50 disabled:opacity-40"
          >
            {testState === "testing" ? (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
            ) : testState === "ok" ? "✅" : testState === "fail" ? "❌" : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/>
              </svg>
            )}
            연결 테스트
          </button>
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending}
            className="px-3 py-1.5 rounded-lg bg-primary-600 text-white text-xs font-medium hover:bg-primary-700 disabled:opacity-40"
          >
            {saveMut.isPending ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>

      <FieldRow label="시스템 URL">
        <TextInput value={cfg.url} onChange={set("url")} placeholder="https://system.example.com" />
      </FieldRow>
      <FieldRow label="로그인 계정">
        <TextInput value={cfg.username} onChange={set("username")} placeholder="admin@example.com" />
      </FieldRow>
      <FieldRow label="비밀번호">
        <div className="relative">
          <TextInput
            type={showPw ? "text" : "password"}
            value={cfg.password}
            onChange={set("password")}
            placeholder="••••••••"
          />
          <button
            type="button"
            onClick={() => setShowPw((v) => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            {showPw ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            )}
          </button>
        </div>
      </FieldRow>
      <FieldRow label="다운로드 경로">
        <TextInput value={cfg.downloadPath} onChange={set("downloadPath")} placeholder="/home/user/downloads" />
      </FieldRow>
    </div>
  );
}

function Tab1SystemConfig() {
  const [divId, setDivId] = useState<DivisionId>("a1000000-0000-0000-0000-000000000001");
  const div = DIVISIONS.find((d) => d.id === divId)!;
  const systems = SYSTEMS_BY_DIVISION[div.code] ?? [];

  return (
    <div className="space-y-4">
      <DivisionSelector value={divId} onChange={setDivId} />
      <SectionCard
        title={`${div.name} — 시스템 연동 설정`}
        subtitle="각 시스템의 접속 URL·계정·다운로드 경로를 설정합니다."
      >
        <div className="space-y-4">
          {systems.map((s) => (
            <SystemConnectionCard
              key={s.code}
              code={s.code}
              label={s.label}
              divisionId={divId}
            />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 탭 2: 캡처 설정
// ─────────────────────────────────────────────────────────────────────────────

function CaptureTargetRow({
  target,
  divisionId,
  onSaved,
}: {
  target:     ScreenshotTarget;
  divisionId: DivisionId;
  onSaved:    () => void;
}) {
  const { success, error: toastError } = useToast();
  const [draft,     setDraft]     = useState<ScreenshotTarget>({ ...target });
  const [expanded,  setExpanded]  = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const set = (key: keyof ScreenshotTarget) => (v: string) =>
    setDraft((p) => ({ ...p, [key]: v || null }));

  const patchMut = useMutation({
    mutationFn: () =>
      apiClient.patch(
        `/api/admin/divisions/${divisionId}/screenshot-config/${target.systemName}`,
        {
          label:           draft.label,
          urlPath:         draft.urlPath,
          selector:        draft.selector,
          waitForSelector: draft.waitForSelector,
          description:     draft.description,
        }
      ),
    onSuccess: () => { success("캡처 설정이 저장되었습니다."); onSaved(); },
    onError:   () => toastError("저장에 실패했습니다."),
  });

  const handlePreview = async () => {
    if (!draft.urlPath) { toastError("URL 경로를 먼저 입력하세요."); return; }
    setPreviewing(true);
    try {
      await apiClient.post("/api/admin/capture-preview", {
        divisionId, systemName: target.systemName, urlPath: draft.urlPath, selector: draft.selector,
      });
      success("캡처 미리보기 요청이 전송되었습니다. 스크린샷이 준비되면 알림이 표시됩니다.");
    } catch {
      toastError("캡처 미리보기 요청에 실패했습니다.");
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      {/* 헤더 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-primary-700 bg-primary-50 px-2 py-0.5 rounded">
            {target.systemName}
          </span>
          <span className="text-sm font-medium text-gray-800">{draft.label}</span>
          <span className="text-xs text-gray-400 truncate max-w-[200px]">{draft.urlPath}</span>
        </div>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* 편집 폼 */}
      {expanded && (
        <div className="p-4 space-y-3 bg-white">
          <FieldRow label="표시 이름">
            <TextInput value={draft.label} onChange={(v) => setDraft((p) => ({ ...p, label: v }))} />
          </FieldRow>
          <FieldRow label="URL 경로">
            <TextInput value={draft.urlPath} onChange={(v) => setDraft((p) => ({ ...p, urlPath: v }))} placeholder="/dashboard/docs" />
          </FieldRow>
          <FieldRow label="CSS 셀렉터">
            <TextInput
              value={draft.selector ?? ""}
              onChange={set("selector")}
              placeholder="#element (비워두면 전체 화면 캡처)"
            />
          </FieldRow>
          <FieldRow label="대기 셀렉터">
            <TextInput
              value={draft.waitForSelector ?? ""}
              onChange={set("waitForSelector")}
              placeholder=".chart-loaded (데이터 로딩 완료 지표)"
            />
          </FieldRow>
          <FieldRow label="설명">
            <TextInput
              value={draft.description}
              onChange={(v) => setDraft((p) => ({ ...p, description: v }))}
              placeholder="이 캡처 대상의 목적"
            />
          </FieldRow>

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={handlePreview}
              disabled={previewing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200
                         text-gray-600 text-xs hover:bg-gray-50 disabled:opacity-40"
            >
              {previewing ? (
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              )}
              캡처 미리보기
            </button>
            <button
              onClick={() => patchMut.mutate()}
              disabled={patchMut.isPending}
              className="px-3 py-1.5 rounded-lg bg-primary-600 text-white text-xs font-medium
                         hover:bg-primary-700 disabled:opacity-40"
            >
              {patchMut.isPending ? "저장 중…" : "저장"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Tab2CaptureConfig() {
  const qc = useQueryClient();
  const { error: toastError, success } = useToast();
  const [divId, setDivId] = useState<DivisionId>("a1000000-0000-0000-0000-000000000001");
  const div = DIVISIONS.find((d) => d.id === divId)!;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin", "screenshot-config", divId],
    queryFn: async () => {
      const res = await apiClient.get<ApiOk<DivisionScreenshotConfig>>(
        `/api/admin/divisions/${divId}/screenshot-config`
      );
      return res.data.data;
    },
  });

  const resetMut = useMutation({
    mutationFn: () => apiClient.delete(`/api/admin/divisions/${divId}/screenshot-config`),
    onSuccess: () => {
      success("코드 기본값으로 초기화되었습니다.");
      void refetch();
    },
    onError: () => toastError("초기화에 실패했습니다."),
  });

  return (
    <div className="space-y-4">
      <DivisionSelector value={divId} onChange={setDivId} />
      <SectionCard
        title={`${div.name} — 캡처 설정`}
        subtitle="시스템별 캡처 URL, CSS 셀렉터, 대기 조건을 편집합니다."
        action={
          <button
            onClick={() => resetMut.mutate()}
            disabled={resetMut.isPending}
            className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 text-xs hover:bg-gray-50 disabled:opacity-40"
          >
            기본값으로 초기화
          </button>
        }
      >
        {isLoading ? (
          <LoadingSpinner centered label="불러오는 중…" />
        ) : (
          <div className="space-y-2">
            {(data?.targets ?? []).map((t) => (
              <CaptureTargetRow
                key={t.systemName}
                target={t}
                divisionId={divId}
                onSaved={() => void qc.invalidateQueries({ queryKey: ["admin", "screenshot-config", divId] })}
              />
            ))}
            {!data?.targets.length && (
              <p className="text-sm text-gray-400 text-center py-6">캡처 설정이 없습니다.</p>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 탭 3: 수신자 그룹 관리
// ─────────────────────────────────────────────────────────────────────────────

function GroupModal({
  mode,
  initial,
  divisionCode,
  onClose,
  onSaved,
}: {
  mode:         "create" | "edit";
  initial?:     RecipientGroup;
  divisionCode: string;
  onClose:      () => void;
  onSaved:      () => void;
}) {
  const { success, error: toastError } = useToast();
  const [name,    setName]    = useState(initial?.name    ?? "");
  const [emails,  setEmails]  = useState(initial?.emails.join("\n") ?? "");

  const parseEmails = () =>
    emails.split(/[,;\s\n]+/).map((e) => e.trim().toLowerCase()).filter((e) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
    );

  const mut = useMutation({
    mutationFn: () => {
      const parsed = parseEmails();
      return mode === "create"
        ? apiClient.post("/api/mail/groups", { division_code: divisionCode, name, emails: parsed })
        : apiClient.put(`/api/mail/groups/${initial!.id}`, { name, emails: parsed });
    },
    onSuccess: () => {
      success(mode === "create" ? "그룹이 생성되었습니다." : "그룹이 수정되었습니다.");
      onSaved();
    },
    onError: () => toastError("저장에 실패했습니다."),
  });

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900">
            {mode === "create" ? "수신자 그룹 추가" : "수신자 그룹 수정"}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">그룹 이름</label>
            <TextInput value={name} onChange={setName} placeholder="예: 바이오 팀 전체" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              이메일 목록
              <span className="font-normal text-gray-400 ml-1">(쉼표·줄바꿈·공백 구분)</span>
            </label>
            <textarea
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              rows={5}
              placeholder={"user1@example.com\nuser2@example.com"}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 resize-y
                         focus:outline-none focus:ring-2 focus:ring-primary-400"
            />
            <p className="text-xs text-gray-400 mt-1">
              유효 이메일: {parseEmails().length}개
            </p>
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-gray-200 text-gray-600 text-sm hover:bg-gray-50">
            취소
          </button>
          <button
            onClick={() => mut.mutate()}
            disabled={!name.trim() || mut.isPending}
            className="flex-1 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-40"
          >
            {mut.isPending ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Tab3RecipientGroups() {
  const { success, error: toastError } = useToast();
  const qc = useQueryClient();
  const [filterDiv, setFilterDiv] = useState<string>("all");
  const [modal, setModal] = useState<
    | { mode: "create"; divisionCode: string }
    | { mode: "edit"; group: RecipientGroup }
    | null
  >(null);

  const { data: groups = [] as RecipientGroup[], isLoading } = useQuery({
    queryKey: ["mail", "groups", "all"],
    queryFn: async () => {
      const res = await apiClient.get<ApiOk<RecipientGroup[]>>("/api/mail/groups");
      return res.data.data;
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/mail/groups/${id}`),
    onSuccess: () => {
      success("그룹이 삭제되었습니다.");
      void qc.invalidateQueries({ queryKey: ["mail", "groups"] });
    },
    onError: () => toastError("삭제에 실패했습니다."),
  });

  const filtered = filterDiv === "all"
    ? groups
    : groups.filter((g: RecipientGroup) => g.division_code === filterDiv);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["mail", "groups"] });

  return (
    <div className="space-y-4">
      {/* 필터 + 추가 버튼 */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={() => setFilterDiv("all")}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${filterDiv === "all" ? "bg-primary-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"}`}
          >
            전체
          </button>
          {DIVISIONS.map((d) => (
            <button
              key={d.code}
              onClick={() => setFilterDiv(d.code)}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${filterDiv === d.code ? "bg-primary-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"}`}
            >
              {d.code}
            </button>
          ))}
        </div>
        <button
          onClick={() => setModal({ mode: "create", divisionCode: filterDiv === "all" ? "BIO" : filterDiv })}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          그룹 추가
        </button>
      </div>

      <SectionCard title="수신자 그룹 목록" subtitle="본부별 기본 수신자 그룹 — 메일 초안 생성 시 자동 적용됩니다.">
        {isLoading ? (
          <LoadingSpinner centered label="불러오는 중…" />
        ) : filtered.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">등록된 그룹이 없습니다.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {filtered.map((g: RecipientGroup) => (
              <div key={g.id} className="py-3 flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold text-primary-700 bg-primary-50 px-1.5 py-0.5 rounded">
                      {g.division_code}
                    </span>
                    <span className="text-sm font-semibold text-gray-800">{g.name}</span>
                    <span className="text-xs text-gray-400">{g.emails.length}명</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {g.emails.slice(0, 5).map((e: string) => (
                      <span key={e} className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                        {e}
                      </span>
                    ))}
                    {g.emails.length > 5 && (
                      <span className="text-xs text-gray-400">+{g.emails.length - 5}명</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => setModal({ mode: "edit", group: g })}
                    className="px-2.5 py-1 rounded border border-gray-200 text-gray-500 text-xs hover:bg-gray-50"
                  >
                    편집
                  </button>
                  <button
                    onClick={() => { if (window.confirm(`"${g.name}" 그룹을 삭제하시겠습니까?`)) deleteMut.mutate(g.id); }}
                    className="px-2.5 py-1 rounded border border-red-100 text-red-400 text-xs hover:bg-red-50"
                  >
                    삭제
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {modal?.mode === "create" && (
        <GroupModal
          mode="create"
          divisionCode={modal.divisionCode}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); void invalidate(); }}
        />
      )}
      {modal?.mode === "edit" && (
        <GroupModal
          mode="edit"
          initial={modal.group}
          divisionCode={modal.group.division_code}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); void invalidate(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 탭 4: 사용자 관리
// ─────────────────────────────────────────────────────────────────────────────

function UserModal({
  mode,
  user,
  onClose,
  onSaved,
}: {
  mode:    "edit" | "create" | "reset-pw";
  user?:   UserRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [name,     setName]     = useState(user?.name     ?? "");
  const [email,    setEmail]    = useState(user?.email    ?? "");
  const [role,     setRole]     = useState<UserRole>(user?.role ?? "viewer");
  const [divCode,  setDivCode]  = useState(user?.division_code ?? "");
  const [password, setPassword] = useState("");
  const [newPw,    setNewPw]    = useState("");

  const mut = useMutation({
    mutationFn: () => {
      if (mode === "create") {
        return apiClient.post("/api/admin/users", { email, name, password, role, divisionCode: divCode || null });
      }
      if (mode === "reset-pw") {
        return apiClient.patch(`/api/admin/users/${user!.id}`, { password: newPw });
      }
      return apiClient.patch(`/api/admin/users/${user!.id}`, {
        name, role, divisionCode: divCode || null,
      });
    },
    onSuccess: () => {
      success(mode === "create" ? "사용자가 생성되었습니다." : mode === "reset-pw" ? "비밀번호가 초기화되었습니다." : "사용자 정보가 수정되었습니다.");
      onSaved();
    },
    onError: () => toastError("처리에 실패했습니다."),
  });

  const title = mode === "create" ? "사용자 추가" : mode === "reset-pw" ? "비밀번호 초기화" : "사용자 편집";

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {mode === "reset-pw" ? (
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">새 비밀번호</label>
            <TextInput type="password" value={newPw} onChange={setNewPw} placeholder="8자 이상" />
          </div>
        ) : (
          <div className="space-y-3">
            {mode === "create" && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">이메일</label>
                  <TextInput value={email} onChange={setEmail} placeholder="user@example.com" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">초기 비밀번호</label>
                  <TextInput type="password" value={password} onChange={setPassword} />
                </div>
              </>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">이름</label>
              <TextInput value={name} onChange={setName} placeholder="홍길동" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">역할</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2
                           focus:outline-none focus:ring-2 focus:ring-primary-400"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r === "admin" ? "관리자" : r === "manager" ? "매니저" : "뷰어"}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">소속 본부</label>
              <select
                value={divCode}
                onChange={(e) => setDivCode(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2
                           focus:outline-none focus:ring-2 focus:ring-primary-400"
              >
                <option value="">— 미배정 —</option>
                {DIVISIONS.map((d) => (
                  <option key={d.code} value={d.code}>{d.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-gray-200 text-gray-600 text-sm hover:bg-gray-50">
            취소
          </button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
            className="flex-1 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-40"
          >
            {mut.isPending ? "처리 중…" : "확인"}
          </button>
        </div>
      </div>
    </div>
  );
}

const ROLE_LABELS: Record<UserRole, string> = {
  admin:   "관리자",
  manager: "매니저",
  viewer:  "뷰어",
};

const ROLE_COLORS: Record<UserRole, string> = {
  admin:   "bg-red-100 text-red-700",
  manager: "bg-blue-100 text-blue-700",
  viewer:  "bg-gray-100 text-gray-600",
};

function Tab4UserManagement() {
  const { error: toastError, success } = useToast();
  const qc = useQueryClient();
  const [modal, setModal] = useState<
    | { type: "create" }
    | { type: "edit";     user: UserRow }
    | { type: "reset-pw"; user: UserRow }
    | null
  >(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await apiClient.get<ApiPaged<UserRow>>("/api/admin/users?limit=100");
      return res.data.data;
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/admin/users/${id}`),
    onSuccess: () => {
      success("사용자가 삭제되었습니다.");
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onError: () => toastError("삭제에 실패했습니다."),
  });

  const users: UserRow[] = data?.items ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin", "users"] });

  return (
    <div className="space-y-4">
      <SectionCard
        title="사용자 관리"
        subtitle="시스템 접근 계정·역할·소속 본부를 관리합니다."
        action={
          <button
            onClick={() => setModal({ type: "create" })}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            사용자 추가
          </button>
        }
      >
        {isLoading ? (
          <LoadingSpinner centered label="불러오는 중…" />
        ) : users.length === 0 ? (
          <div className="text-center py-12 space-y-2">
            <svg className="w-10 h-10 mx-auto text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <p className="text-sm text-gray-400">등록된 사용자가 없습니다.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left text-xs font-semibold text-gray-500 py-2 pr-4">이름 / 이메일</th>
                  <th className="text-left text-xs font-semibold text-gray-500 py-2 pr-4">역할</th>
                  <th className="text-left text-xs font-semibold text-gray-500 py-2 pr-4">소속 본부</th>
                  <th className="text-right text-xs font-semibold text-gray-500 py-2">작업</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {users.map((u: UserRow) => (
                  <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                    <td className="py-3 pr-4">
                      <p className="font-medium text-gray-800">{u.name}</p>
                      <p className="text-xs text-gray-400">{u.email}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${ROLE_COLORS[u.role]}`}>
                        {ROLE_LABELS[u.role]}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <span className="text-xs text-gray-600">{u.division_name ?? "미배정"}</span>
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => setModal({ type: "edit", user: u })}
                          className="px-2.5 py-1 rounded border border-gray-200 text-gray-500 text-xs hover:bg-gray-50"
                        >
                          편집
                        </button>
                        <button
                          onClick={() => setModal({ type: "reset-pw", user: u })}
                          className="px-2.5 py-1 rounded border border-amber-200 text-amber-600 text-xs hover:bg-amber-50"
                        >
                          비밀번호 초기화
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`"${u.name}" 사용자를 삭제하시겠습니까?`))
                              deleteMut.mutate(u.id);
                          }}
                          className="px-2.5 py-1 rounded border border-red-100 text-red-400 text-xs hover:bg-red-50"
                        >
                          삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {modal?.type === "create" && (
        <UserModal mode="create" onClose={() => setModal(null)} onSaved={() => { setModal(null); void invalidate(); }} />
      )}
      {modal?.type === "edit" && (
        <UserModal mode="edit" user={modal.user} onClose={() => setModal(null)} onSaved={() => { setModal(null); void invalidate(); }} />
      )}
      {modal?.type === "reset-pw" && (
        <UserModal mode="reset-pw" user={modal.user} onClose={() => setModal(null)} onSaved={() => { setModal(null); void invalidate(); }} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 메인 페이지
// ─────────────────────────────────────────────────────────────────────────────

type TabId = "system" | "capture" | "groups" | "users";

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  {
    id: "system",
    label: "시스템 연동 설정",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    id: "capture",
    label: "캡처 설정",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    id: "groups",
    label: "수신자 그룹",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
      </svg>
    ),
  },
  {
    id: "users",
    label: "사용자 관리",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    ),
  },
];

export function Settings() {
  const [activeTab, setActiveTab] = useState<TabId>("system");

  return (
    <AppLayout title="설정">
      <div className="max-w-5xl mx-auto">
        {/* 헤더 */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-gray-900">관리자 설정</h1>
          <p className="text-sm text-gray-400 mt-0.5">시스템 연동·캡처·수신자·사용자 설정 (관리자 전용)</p>
        </div>

        {/* 탭 */}
        <div className="flex gap-1 p-1 bg-gray-100 rounded-xl mb-6 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
                activeTab === t.id
                  ? "bg-white text-primary-700 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* 탭 콘텐츠 */}
        {activeTab === "system"  && <Tab1SystemConfig />}
        {activeTab === "capture" && <Tab2CaptureConfig />}
        {activeTab === "groups"  && <Tab3RecipientGroups />}
        {activeTab === "users"   && <Tab4UserManagement />}
      </div>
    </AppLayout>
  );
}
