import { DivisionReportPage } from "../components/division/DivisionReportPage";

const SYSTEMS = [
  { code: "VEEVA", label: "Veeva (eQMS, eDMS, eLMS)" },
];

export function LhousePage() {
  return (
    <DivisionReportPage
      divisionCode="LHOUSE"
      divisionName="L HOUSE 공장"
      systems={SYSTEMS}
      sideLayout
    />
  );
}
