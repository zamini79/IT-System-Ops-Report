import { DivisionReportPage } from "../components/division/DivisionReportPage";

const SYSTEMS = [
  { code: "EDMS",      label: "eDMS" },
  { code: "ELN",       label: "ELN" },
  { code: "GCLP_LIMS", label: "GCLP LIMS" },
];

export function BioResearchPage() {
  return (
    <DivisionReportPage
      divisionCode="BIO"
      divisionName="Bio연구본부"
      systems={SYSTEMS}
    />
  );
}
