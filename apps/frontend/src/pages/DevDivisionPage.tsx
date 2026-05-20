import { DivisionReportPage } from "../components/division/DivisionReportPage";

const SYSTEMS = [
  { code: "GCP_QUALITY", label: "GCP Quality System" },
  { code: "MEDCOMMS",    label: "Medcomms" },
  { code: "CTMS",        label: "Clinical Trial Management System" },
];

export function DevDivisionPage() {
  return (
    <DivisionReportPage
      divisionCode="DEV"
      divisionName="개발본부"
      systems={SYSTEMS}
      sideLayout
    />
  );
}
