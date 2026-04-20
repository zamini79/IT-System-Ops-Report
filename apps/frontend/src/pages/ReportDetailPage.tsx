import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "react-router-dom";
import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { apiClient } from "../api/client";
import { ApiResponse, Report } from "@skbs/shared";

export function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading } = useQuery({
    queryKey: ["report", id],
    queryFn: () =>
      apiClient
        .get<ApiResponse<Report>>(`/reports/${id}`)
        .then((r) => r.data.data),
  });

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const form = new FormData();
      acceptedFiles.forEach((f) => form.append("files", f));
      await apiClient.post(`/reports/${id}/attachments`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
    },
    [id]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  if (isLoading) return <div className="p-6">로딩 중...</div>;
  if (!data) return <div className="p-6">보고서를 찾을 수 없습니다.</div>;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-3xl mx-auto">
        <Link to="/reports" className="text-blue-600 hover:underline text-sm mb-4 block">
          ← 목록으로
        </Link>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center gap-3 mb-4">
            <h1 className="text-2xl font-bold text-gray-800">{data.title}</h1>
            <span className="px-2 py-1 rounded-full text-xs bg-blue-100 text-blue-700">
              {data.status}
            </span>
          </div>
          <p className="text-sm text-gray-500 mb-6">분류: {data.category}</p>
          <div className="prose max-w-none text-gray-700 whitespace-pre-wrap">
            {data.content}
          </div>

          {/* File upload dropzone */}
          <div
            {...getRootProps()}
            className={`mt-6 border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
              isDragActive
                ? "border-blue-400 bg-blue-50"
                : "border-gray-300 hover:border-blue-300"
            }`}
          >
            <input {...getInputProps()} />
            <p className="text-gray-500 text-sm">
              {isDragActive
                ? "파일을 여기에 놓으세요"
                : "첨부파일을 드래그하거나 클릭하여 업로드"}
            </p>
          </div>

          {data.attachments?.length > 0 && (
            <ul className="mt-4 space-y-1">
              {data.attachments.map((att) => (
                <li key={att.id}>
                  <a
                    href={att.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline text-sm"
                  >
                    {att.originalName}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
