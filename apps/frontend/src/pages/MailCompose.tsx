/**
 * MailCompose
 *
 * jobId / divisionCode 를 location.state 또는 query param 으로 받아
 * 메일 초안을 자동 생성하거나 기존 초안을 불러온 뒤 WYSIWYG 에디터로 편집·저장합니다.
 *
 * 레이아웃:
 *  ┌─────────────────────────────────────────────────────────┐
 *  │  헤더 (제목 + 버튼)                                      │
 *  ├────────────────────────────────┬────────────────────────┤
 *  │  수신자 / 참조 / 제목 / 에디터  │  수신자 그룹 패널        │
 *  ├────────────────────────────────┴────────────────────────┤
 *  │  첨부파일 안내 + 하단 버튼                                │
 *  └─────────────────────────────────────────────────────────┘
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

// Tiptap
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";

import { apiClient } from "../api/client";
import { useToast, LoadingSpinner } from "../components/common";
import type { AxiosResponse } from "axios";

// ── API 타입 ──────────────────────────────────────────────────────────────────

interface DraftRow {
  id:            string;
  report_job_id: string;
  recipients:    string[];
  cc:            string[];
  subject:       string;
  body_html:     string;
  pdf_path?:     string | null;
  created_at:    string;
  updated_at:    string;
}

interface RecipientGroup {
  id:            string;
  division_code: string;
  name:          string;
  emails:        string[];
}

interface ApiOkResponse<T>   { data: T }
interface ApiListResponse<T> { data: { items: T[]; total: number } }

// ── TagInput ──────────────────────────────────────────────────────────────────

interface TagInputProps {
  label:    string;
  tags:     string[];
  onChange: (next: string[]) => void;
}

function TagInput({ label, tags, onChange }: TagInputProps) {
  const [val, setVal] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  const commit = useCallback(
    (raw: string) => {
      const next = raw
        .split(/[,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && !tags.includes(s));
      if (next.length) onChange([...tags, ...next]);
      setVal("");
    },
    [tags, onChange],
  );

  const remove = (email: string) => onChange(tags.filter((t) => t !== email));

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (["Enter", ",", "Tab"].includes(e.key)) {
      e.preventDefault();
      if (val.trim()) commit(val);
    } else if (e.key === "Backspace" && !val && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      <div
        className="flex flex-wrap gap-1.5 min-h-[38px] px-2 py-1.5 border border-gray-200 rounded-lg bg-white
                   cursor-text focus-within:ring-2 focus-within:ring-primary-400 focus-within:border-primary-400"
        onClick={() => ref.current?.focus()}
      >
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs
                       bg-primary-100 text-primary-800 font-medium"
          >
            {t}
            <button
              type="button"
              onClick={() => remove(t)}
              className="leading-none text-primary-400 hover:text-primary-700"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={ref}
          type="text"
          value={val}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setVal(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => { if (val.trim()) commit(val); }}
          placeholder={tags.length ? "" : "이메일 입력 후 Enter"}
          className="flex-1 min-w-[180px] text-sm outline-none bg-transparent py-0.5 px-1"
        />
      </div>
    </div>
  );
}

// ── 에디터 툴바 ───────────────────────────────────────────────────────────────

interface ToolbarProps {
  editor: Editor;
}

function Toolbar({ editor }: ToolbarProps) {
  const btn = (active: boolean) =>
    `px-2 py-1 rounded text-sm transition-colors ${
      active
        ? "bg-primary-600 text-white"
        : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-200"
    }`;

  const insertImage = () => {
    const url = window.prompt("이미지 URL 입력");
    if (url) editor.chain().focus().setImage({ src: url }).run();
  };

  const insertTable = () =>
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();

  return (
    <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
      {/* 텍스트 서식 */}
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={btn(editor.isActive("bold"))}
        title="굵게 (Ctrl+B)"
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={btn(editor.isActive("italic"))}
        title="기울임 (Ctrl+I)"
      >
        <em>I</em>
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleStrike().run()}
        className={btn(editor.isActive("strike"))}
        title="취소선"
      >
        <s>S</s>
      </button>

      <div className="w-px h-5 bg-gray-300 mx-1" />

      {/* 제목 */}
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        className={btn(editor.isActive("heading", { level: 2 }))}
        title="제목 2"
      >
        H2
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        className={btn(editor.isActive("heading", { level: 3 }))}
        title="제목 3"
      >
        H3
      </button>

      <div className="w-px h-5 bg-gray-300 mx-1" />

      {/* 목록 */}
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        className={btn(editor.isActive("bulletList"))}
        title="글머리 목록"
      >
        • 목록
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        className={btn(editor.isActive("orderedList"))}
        title="번호 목록"
      >
        1. 목록
      </button>

      <div className="w-px h-5 bg-gray-300 mx-1" />

      {/* 테이블 */}
      <button
        type="button"
        onClick={insertTable}
        className={btn(editor.isActive("table"))}
        title="테이블 삽입"
      >
        표
      </button>
      {editor.isActive("table") && (
        <>
          <button
            type="button"
            onClick={() => editor.chain().focus().addColumnAfter().run()}
            className={btn(false)}
            title="열 추가"
          >
            +열
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().addRowAfter().run()}
            className={btn(false)}
            title="행 추가"
          >
            +행
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().deleteTable().run()}
            className="px-2 py-1 rounded text-sm bg-white text-red-500 hover:bg-red-50 border border-gray-200"
            title="테이블 삭제"
          >
            표 삭제
          </button>
        </>
      )}

      <div className="w-px h-5 bg-gray-300 mx-1" />

      {/* 이미지 */}
      <button
        type="button"
        onClick={insertImage}
        className={btn(false)}
        title="이미지 삽입"
      >
        이미지
      </button>

      <div className="w-px h-5 bg-gray-300 mx-1" />

      {/* 되돌리기 */}
      <button
        type="button"
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
        className="px-2 py-1 rounded text-sm bg-white text-gray-600 hover:bg-gray-100 border border-gray-200 disabled:opacity-30"
        title="실행 취소"
      >
        ↩
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
        className="px-2 py-1 rounded text-sm bg-white text-gray-600 hover:bg-gray-100 border border-gray-200 disabled:opacity-30"
        title="다시 실행"
      >
        ↪
      </button>
    </div>
  );
}

// ── 수신자 그룹 드롭다운 ──────────────────────────────────────────────────────

interface GroupDropdownProps {
  divisionCode: string;
  onApply:      (emails: string[]) => void;
}

function GroupDropdown({ divisionCode, onApply }: GroupDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data: groups = [] as RecipientGroup[] } = useQuery({
    queryKey: ["mail", "groups", divisionCode],
    queryFn: async () => {
      const res = await apiClient.get<ApiOkResponse<RecipientGroup[]>>(
        `/api/mail/groups?division=${divisionCode}`,
      );
      return res.data.data;
    },
    enabled: !!divisionCode,
  });

  // 외부 클릭 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  if (!groups.length) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-700
                   bg-white hover:bg-gray-50 whitespace-nowrap"
      >
        수신자 그룹
        <svg className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-64 bg-white border border-gray-200 rounded-xl shadow-lg z-20 py-1 max-h-72 overflow-y-auto">
          {groups.map((g: RecipientGroup) => (
            <button
              key={g.id}
              type="button"
              onClick={() => { onApply(g.emails); setOpen(false); }}
              className="w-full text-left px-4 py-2.5 hover:bg-gray-50 border-b border-gray-100 last:border-none"
            >
              <p className="text-sm font-medium text-gray-800">{g.name}</p>
              <p className="text-xs text-gray-500 truncate mt-0.5">{g.emails.join(", ")}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 첨부파일 안내 ─────────────────────────────────────────────────────────────

interface AttachmentBarProps {
  pdfFilename: string | null;
}

function AttachmentBar({ pdfFilename }: AttachmentBarProps) {
  if (!pdfFilename) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg">
      {/* PDF 아이콘 */}
      <svg className="w-5 h-5 text-red-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
      </svg>
      <span className="text-sm text-gray-700 font-medium">{pdfFilename}</span>
      <span className="text-xs text-gray-400 ml-1">(보고서 PDF — 메일 클라이언트에서 직접 첨부하세요)</span>
    </div>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────────────────

export function MailCompose() {
  const location        = useLocation();
  const [searchParams]  = useSearchParams();
  const navigate        = useNavigate();
  const { success, error: toastError } = useToast();
  const qc              = useQueryClient();

  // ── jobId / divisionCode 추출 ────────────────────────────────────────────
  const st           = location.state as { jobId?: string; divisionCode?: string } | null;
  const jobId        = st?.jobId        ?? searchParams.get("jobId")        ?? null;
  const divisionCode = st?.divisionCode ?? searchParams.get("divisionCode") ?? "";

  // ── 기존 초안 조회 ───────────────────────────────────────────────────────
  const draftsQuery = useQuery({
    queryKey: ["mail", "drafts", jobId],
    queryFn: async () => {
      const res = await apiClient.get<ApiListResponse<DraftRow>>(
        `/api/mail/draft?jobId=${jobId}&limit=1`,
      );
      return res.data.data;
    },
    enabled: !!jobId,
  });

  const existingDraft = draftsQuery.data?.items[0] ?? null;

  // ── 자동 초안 생성 ───────────────────────────────────────────────────────
  const autoGenRef = useRef(false);

  const generateMut = useMutation({
    mutationFn: () =>
      apiClient.post<ApiOkResponse<DraftRow>>("/api/mail/draft", { jobId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mail", "drafts", jobId] });
    },
    onError: () => toastError("메일 초안 자동 생성에 실패했습니다."),
  });

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

  // ── 폼 상태 ─────────────────────────────────────────────────────────────
  const [draftId,    setDraftId]    = useState<string | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [cc,         setCc]         = useState<string[]>([]);
  const [subject,    setSubject]    = useState("");
  const [pdfPath,    setPdfPath]    = useState<string | null>(null);
  const [dirty,      setDirty]      = useState(false);

  // ── Tiptap 에디터 ────────────────────────────────────────────────────────
  const editor = useEditor({
    extensions: [
      StarterKit,
      Image.configure({ allowBase64: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: "",
    onUpdate: () => setDirty(true),
    editorProps: {
      attributes: {
        class:
          "min-h-[400px] px-6 py-4 prose prose-sm max-w-none focus:outline-none text-gray-800",
      },
    },
  });

  // ── 초안 → 폼 반영 (최초 1회) ───────────────────────────────────────────
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!existingDraft || loadedRef.current) return;
    loadedRef.current = true;

    setDraftId(existingDraft.id);
    setRecipients(existingDraft.recipients);
    setCc(existingDraft.cc);
    setSubject(existingDraft.subject);
    setPdfPath(existingDraft.pdf_path ?? null);

    if (editor && existingDraft.body_html) {
      editor.commands.setContent(existingDraft.body_html, { emitUpdate: false });
    }
  }, [existingDraft, editor]);

  // ── 초안 저장 ────────────────────────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: () => {
      if (!draftId) throw new Error("초안 ID 없음");
      return apiClient.put<ApiOkResponse<DraftRow>>(`/api/mail/draft/${draftId}`, {
        recipients,
        cc,
        subject,
        body_html: editor?.getHTML() ?? "",
      });
    },
    onSuccess: (res: AxiosResponse<ApiOkResponse<DraftRow>>) => {
      const updated = res.data.data;
      setDraftId(updated.id);
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["mail", "drafts", jobId] });
      success("메일 초안이 저장되었습니다.");
    },
    onError: () => toastError("저장에 실패했습니다."),
  });

  // ── 그룹 적용 ────────────────────────────────────────────────────────────
  const handleApplyGroup = (emails: string[]) => {
    setRecipients((prev) => [...new Set([...prev, ...emails])]);
    setDirty(true);
  };

  // ── mailto 열기 ──────────────────────────────────────────────────────────
  const openMailto = () => {
    const html   = editor?.getHTML() ?? "";
    const plain  = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const params = new URLSearchParams();
    if (cc.length)       params.set("cc",      cc.join(","));
    if (subject)         params.set("subject", subject);
    if (plain)           params.set("body",    plain);
    const href = `mailto:${recipients.join(",")}?${params.toString()}`;
    window.open(href, "_blank");
  };

  const pdfFilename = pdfPath ? pdfPath.split("/").pop() ?? null : null;
  const isLoading   = draftsQuery.isLoading || generateMut.isPending;

  // ── jobId 없음 ───────────────────────────────────────────────────────────
  if (!jobId) {
    return (
      <div className="p-12 flex flex-col items-center gap-4 text-center">
        <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
          <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <p className="text-gray-600 font-medium">보고서 생성 페이지에서 이동해 주세요.</p>
        <p className="text-sm text-gray-400">jobId 파라미터가 필요합니다.</p>
        <button
          onClick={() => navigate("/dashboard")}
          className="mt-2 px-4 py-2 rounded-lg bg-primary-600 text-white text-sm hover:bg-primary-700"
        >
          대시보드로
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      {/* ── 헤더 ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">메일 작성</h1>
          {divisionCode && (
            <p className="text-xs text-gray-400 mt-0.5">{divisionCode} 보고서 메일 초안</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 text-sm hover:bg-gray-50"
          >
            뒤로
          </button>
          <button
            onClick={openMailto}
            disabled={!draftId || recipients.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-secondary-300
                       text-secondary-700 text-sm hover:bg-secondary-50 disabled:opacity-40"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            메일 클라이언트로 열기
          </button>
          <button
            onClick={() => saveMut.mutate()}
            disabled={!draftId || saveMut.isPending || !dirty}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-primary-600 text-white text-sm
                       hover:bg-primary-700 disabled:opacity-40"
          >
            {saveMut.isPending ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                저장 중...
              </>
            ) : (
              "초안 저장"
            )}
          </button>
        </div>
      </div>

      {/* ── 로딩 ── */}
      {isLoading && (
        <div className="flex items-center justify-center h-64 bg-white border border-gray-200 rounded-xl">
          <LoadingSpinner centered label="메일 초안 생성 중..." />
        </div>
      )}

      {/* ── 생성 실패 ── */}
      {!isLoading && generateMut.isError && (
        <div className="flex items-center justify-between px-5 py-4 bg-red-50 border border-red-200 rounded-xl">
          <p className="text-sm text-red-700 font-medium">메일 초안 생성에 실패했습니다.</p>
          <button
            onClick={() => { autoGenRef.current = false; generateMut.reset(); generateMut.mutate(); }}
            className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm hover:bg-red-700"
          >
            재시도
          </button>
        </div>
      )}

      {/* ── 메인 편집 영역 ── */}
      {!isLoading && draftId && (
        <>
          {/* 수신자 / 참조 / 제목 폼 */}
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            {/* 받는 사람 */}
            <div className="flex items-start gap-3 px-4 py-3">
              <span className="shrink-0 text-xs font-medium text-gray-400 w-16 pt-2">받는 사람</span>
              <div className="flex-1 flex items-start gap-2">
                <div className="flex-1">
                  <TagInput
                    label=""
                    tags={recipients}
                    onChange={(t) => { setRecipients(t); setDirty(true); }}
                  />
                </div>
                {divisionCode && (
                  <GroupDropdown divisionCode={divisionCode} onApply={handleApplyGroup} />
                )}
              </div>
            </div>

            {/* 참조 */}
            <div className="flex items-start gap-3 px-4 py-3">
              <span className="shrink-0 text-xs font-medium text-gray-400 w-16 pt-2">참조 (CC)</span>
              <div className="flex-1">
                <TagInput
                  label=""
                  tags={cc}
                  onChange={(t) => { setCc(t); setDirty(true); }}
                />
              </div>
            </div>

            {/* 제목 */}
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="shrink-0 text-xs font-medium text-gray-400 w-16">제목</span>
              <input
                type="text"
                value={subject}
                onChange={(e) => { setSubject(e.target.value); setDirty(true); }}
                className="flex-1 text-sm text-gray-900 bg-transparent outline-none
                           border-b border-transparent focus:border-primary-400 py-0.5 transition-colors"
                placeholder="메일 제목"
              />
            </div>
          </div>

          {/* WYSIWYG 에디터 */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            {editor && <Toolbar editor={editor} />}
            <EditorContent editor={editor} />
          </div>

          {/* 첨부파일 안내 + 하단 버튼 */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <AttachmentBar pdfFilename={pdfFilename} />

            <div className="flex items-center gap-2 ml-auto">
              {dirty && (
                <span className="text-xs text-amber-600">저장되지 않은 변경사항</span>
              )}
              {!dirty && existingDraft && (
                <span className="text-xs text-gray-400">
                  저장: {new Date(existingDraft.updated_at).toLocaleString("ko-KR")}
                </span>
              )}
              <button
                onClick={openMailto}
                disabled={recipients.length === 0}
                className="px-3 py-1.5 rounded-lg border border-secondary-300 text-secondary-700
                           text-sm hover:bg-secondary-50 disabled:opacity-40"
              >
                메일 클라이언트로 열기
              </button>
              <button
                onClick={() => saveMut.mutate()}
                disabled={!dirty || saveMut.isPending}
                className="px-4 py-1.5 rounded-lg bg-primary-600 text-white text-sm
                           hover:bg-primary-700 disabled:opacity-40"
              >
                {saveMut.isPending ? "저장 중..." : "초안 저장"}
              </button>
            </div>
          </div>

          {/* 수신자 요약 */}
          <div className="flex items-center gap-4 text-xs text-gray-400 pb-2">
            <span>받는 사람 {recipients.length}명</span>
            {cc.length > 0 && <span>참조 {cc.length}명</span>}
            <span className="truncate max-w-[200px] font-mono text-gray-300">Job: {jobId}</span>
          </div>
        </>
      )}
    </div>
  );
}
