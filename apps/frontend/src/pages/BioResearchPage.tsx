import { DivisionReportPage } from "../components/division/DivisionReportPage";

const SYSTEMS = [
  { code: "EDMS", label: "Veeva (eDMS)" },
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
