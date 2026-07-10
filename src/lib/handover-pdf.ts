import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { STATUS_LABELS, fmtDate } from "@/lib/icu";

export type HandoverPatient = Record<string, any>;

function joinNonEmpty(parts: (string | null | undefined | false)[], sep = "\n"): string {
  return parts.filter(Boolean).join(sep);
}

function identity(p: HandoverPatient): string {
  return joinNonEmpty([
    p.full_name?.trim() || "—",
    p.age != null ? `Age ${p.age}` : null,
    p.hospital_number ? `MRN ${p.hospital_number}` : null,
  ]);
}

function location(p: HandoverPatient): string {
  return joinNonEmpty([
    p.ward ? `${p.ward}${p.bed ? ` · Bed ${p.bed}` : ""}` : "No location",
    STATUS_LABELS[p.status] ?? p.status,
    `Adm ${fmtDate(p.admission_date)}`,
  ]);
}

function flags(p: HandoverPatient): string {
  const f: string[] = [];
  if (p.dnacpr_decision) f.push(`DNACPR${p.dnacpr_details ? `: ${p.dnacpr_details}` : ""}`);
  if (p.tep_in_place) f.push(`TEP${p.tep_details ? `: ${p.tep_details}` : ""}`);
  if (p.nok_name) f.push(`NOK: ${p.nok_name}${p.nok_relationship ? ` (${p.nok_relationship})` : ""}${p.nok_contact ? ` ${p.nok_contact}` : ""}`);
  return f.length ? f.join("\n") : "—";
}

/**
 * Build and download a landscape A4 handover sheet. Every patient becomes one
 * row in a printable table; long free-text fields wrap within their column so
 * each patient's information is scaled to fit on the sheet across pages.
 */
export function exportHandoverPdf(patients: HandoverPatient[], opts?: { title?: string }): void {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const generated = new Date().toLocaleString("en-GB");
  const title = opts?.title ?? "ICU Handover Sheet";

  autoTable(doc, {
    head: [[
      "Patient",
      "Location / status",
      "Past medical history",
      "Current admission",
      "Management",
      "Outstanding tasks",
      "TEP / DNACPR / NOK",
    ]],
    body: patients.map((p) => [
      identity(p),
      location(p),
      p.past_medical_history || "—",
      p.current_admission || "—",
      p.current_management || "—",
      p.outstanding_tasks || "—",
      flags(p),
    ]),
    startY: 20,
    margin: { top: 18, left: 8, right: 8, bottom: 12 },
    styles: {
      fontSize: 7,
      cellPadding: 1.5,
      overflow: "linebreak",
      valign: "top",
      lineColor: [180, 180, 180],
      lineWidth: 0.1,
    },
    headStyles: {
      fillColor: [15, 23, 42],
      textColor: [255, 255, 255],
      fontSize: 7.5,
      fontStyle: "bold",
    },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    columnStyles: {
      0: { cellWidth: 32, fontStyle: "bold" },
      1: { cellWidth: 32 },
      2: { cellWidth: 42 },
      3: { cellWidth: 48 },
      4: { cellWidth: 48 },
      5: { cellWidth: 42 },
      6: { cellWidth: 37 },
    },
    didDrawPage: () => {
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text(title, 8, 12);
      doc.setFontSize(8);
      doc.setTextColor(110, 110, 110);
      doc.text(`Generated ${generated}`, pageWidth - 8, 12, { align: "right" });
      const page = doc.getNumberOfPages();
      doc.text(
        `Confidential — patient identifiable information · Page ${page}`,
        pageWidth / 2,
        doc.internal.pageSize.getHeight() - 5,
        { align: "center" },
      );
    },
  });

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  doc.save(`icu-handover-${stamp}.pdf`);
}
