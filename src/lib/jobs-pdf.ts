import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { sanitizePdfMetadataText } from "@/lib/handover-pdf";
import { fmtDateTime } from "@/lib/icu";
import {
  TASK_STATUS_LABEL,
  TASK_PRIORITY_LABEL,
  TASK_CATEGORY_LABEL,
  type TaskStatus,
  type TaskPriority,
  type TaskCategory,
} from "@/lib/patient-tasks.functions";
import { dueLevel } from "@/lib/task-reminders";
import { formatInitials, formatSexLong } from "@/components/PatientSummary";

export type JobsPdfTask = {
  id: string;
  description: string;
  status: string;
  priority: string | null;
  category: string | null;
  owner: string | null;
  due_at: string | null;
  notes: string | null;
};

export type JobsPdfGroup = {
  patient: {
    id: string;
    full_name?: string | null;
    age?: number | null;
    sex?: string | null;
    hospital_number?: string | null;
    bed?: string | null;
    ward?: string | null;
  };
  tasks: JobsPdfTask[];
};

export type JobsPdfOptions = {
  title?: string;
  subtitle?: string;
  /** Leave blank lines under each patient for handwritten additions. */
  writeInLines?: number;
  includeNotes?: boolean;
  /** A4 page orientation; landscape fits more job detail per page. */
  orientation?: "portrait" | "landscape";
};

const DEFAULT_TITLE = "ICU jobs list";
const FOOTER = "Confidential — patient identifiable information";
const PAGE_TOKEN = "{{TOTAL_PAGES}}";

// Printable tick boxes: an empty box for outstanding work, a part-marker for
// in-progress, and a filled box for completed jobs. Uses ASCII-safe glyphs so
// the built-in helvetica font renders them cleanly.
function statusBox(status: string): string {
  if (status === "completed") return "[X]";
  if (status === "in_progress") return "[/]";
  return "[ ]";
}

function patientHeading(p: JobsPdfGroup["patient"]): string {
  const bits = [
    formatInitials(p),
    p.age != null ? `${p.age}y` : null,
    formatSexLong(p.sex),
    p.hospital_number ? `MRN ${p.hospital_number}` : null,
    p.bed ? `Bed ${p.bed}` : p.ward ? p.ward : null,
  ].filter(Boolean);
  return bits.join("  ·  ");
}

/** Build a printable ward-round jobs sheet grouped by patient. */
export function buildJobsPdf(groups: JobsPdfGroup[], opts?: JobsPdfOptions): jsPDF {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 10;
  const title = opts?.title?.trim() || DEFAULT_TITLE;
  const subtitle = opts?.subtitle?.trim() || "";
  const includeNotes = opts?.includeNotes ?? true;
  const writeInLines = Math.max(0, Math.min(6, opts?.writeInLines ?? 2));
  const generated = new Date().toLocaleString("en-GB", { hour12: false, hourCycle: "h23" });

  doc.setDocumentProperties({
    title: sanitizePdfMetadataText(title, DEFAULT_TITLE),
    subject: sanitizePdfMetadataText(subtitle, DEFAULT_TITLE),
    author: sanitizePdfMetadataText(FOOTER, FOOTER),
    creator: "ICU Handover",
  });

  const drawChrome = () => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text(title, marginX, 12);
    doc.setFont("helvetica", "normal");
    if (subtitle) {
      doc.setFontSize(8);
      doc.setTextColor(90, 90, 90);
      doc.text(subtitle, marginX, 17);
    }
    doc.setFontSize(8);
    doc.setTextColor(110, 110, 110);
    doc.text(`Generated ${generated}`, pageWidth - marginX, 12, { align: "right" });
    doc.text(
      `${FOOTER} · Page ${doc.getNumberOfPages()} of ${PAGE_TOKEN}`,
      pageWidth / 2,
      pageHeight - 6,
      { align: "center" },
    );
  };

  const topMargin = subtitle ? 22 : 18;
  let cursorY = topMargin;
  let pageStamped = false;

  const ensureSpace = (needed: number) => {
    if (cursorY + needed > pageHeight - 14) {
      doc.addPage();
      drawChrome();
      cursorY = topMargin;
    }
  };

  if (groups.length === 0) {
    drawChrome();
    doc.setFontSize(10);
    doc.setTextColor(90, 90, 90);
    doc.text("No jobs to print.", marginX, cursorY + 6);
    if (typeof doc.putTotalPages === "function") doc.putTotalPages(PAGE_TOKEN);
    return doc;
  }

  for (const group of groups) {
    ensureSpace(24);
    if (!pageStamped) {
      drawChrome();
      pageStamped = true;
    }

    // Patient banner
    doc.setFillColor(15, 23, 42);
    doc.rect(marginX, cursorY, pageWidth - marginX * 2, 7, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(255, 255, 255);
    doc.text(patientHeading(group.patient), marginX + 2, cursorY + 4.8);
    const open = group.tasks.filter((t) => t.status !== "completed").length;
    doc.text(`${open} open / ${group.tasks.length} total`, pageWidth - marginX - 2, cursorY + 4.8, {
      align: "right",
    });
    cursorY += 7;

    const body = group.tasks.map((t) => {
      const status = (t.status ?? "not_started") as TaskStatus;
      const priority = (t.priority ?? "routine") as TaskPriority;
      const category = (t.category ?? "job") as TaskCategory;
      const due = t.due_at
        ? `${dueLevel(t.due_at) === "overdue" ? "OVERDUE " : ""}${fmtDateTime(t.due_at)}`
        : "—";
      const desc =
        includeNotes && t.notes?.trim()
          ? `${t.description}\nNote: ${t.notes.trim()}`
          : t.description;
      return [
        statusBox(status),
        desc,
        `${TASK_PRIORITY_LABEL[priority] ?? "Routine"} · ${TASK_CATEGORY_LABEL[category] ?? "Job"}`,
        t.owner || "—",
        due,
        TASK_STATUS_LABEL[status] ?? "Not started",
      ];
    });

    if (body.length === 0) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8);
      doc.setTextColor(120, 120, 120);
      doc.text("No jobs recorded.", marginX + 2, cursorY + 5);
      cursorY += 8;
    } else {
      autoTable(doc, {
        head: [["", "Job", "Priority / type", "Owner", "Due", "Status"]],
        body,
        startY: cursorY,
        margin: { top: topMargin, left: marginX, right: marginX, bottom: 12 },
        tableWidth: pageWidth - marginX * 2,
        styles: {
          fontSize: 8,
          cellPadding: 1.6,
          overflow: "linebreak",
          valign: "top",
          lineColor: [180, 180, 180],
          lineWidth: 0.1,
        },
        headStyles: {
          fillColor: [235, 238, 243],
          textColor: [30, 41, 59],
          fontSize: 7.5,
          fontStyle: "bold",
        },
        columnStyles: {
          0: { cellWidth: 9, halign: "center", fontStyle: "bold" },
          1: { cellWidth: 78 },
          2: { cellWidth: 27 },
          3: { cellWidth: 22 },
          4: { cellWidth: 28 },
          5: { cellWidth: 26 },
        },
        didDrawPage: () => {
          drawChrome();
        },
      });
      cursorY = (doc as any).lastAutoTable.finalY + 2;
    }

    // Blank ruled lines so the team can add jobs by hand on the round.
    if (writeInLines > 0) {
      ensureSpace(writeInLines * 6 + 4);
      doc.setDrawColor(200, 200, 200);
      doc.setLineWidth(0.1);
      doc.setTextColor(120, 120, 120);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      for (let i = 0; i < writeInLines; i++) {
        cursorY += 6;
        doc.text("[ ]", marginX + 1, cursorY - 0.8);
        doc.line(marginX + 10, cursorY, pageWidth - marginX, cursorY);
      }
      cursorY += 4;
    }

    cursorY += 3;
  }

  if (typeof doc.putTotalPages === "function") doc.putTotalPages(PAGE_TOKEN);
  return doc;
}

/** Build the jobs sheet and trigger a download. */
export function downloadJobsPdf(groups: JobsPdfGroup[], opts?: JobsPdfOptions): void {
  const stamp = new Date()
    .toLocaleString("en-GB", { hour12: false, hourCycle: "h23" })
    .replace(/[/:]/g, "-")
    .replace(/[, ]+/g, "_");
  const blob = buildJobsPdf(groups, opts).output("blob");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `icu-jobs-list_${stamp}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
