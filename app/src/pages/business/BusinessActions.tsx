import { SubTabs, useSubTab } from "../../components/ui/SubTabs";
import BusinessTasks from "./BusinessTasks";
import BusinessOpportunities from "./BusinessOpportunities";
import BusinessDecisions from "./BusinessDecisions";
import BusinessTracking from "./BusinessTracking";

// פעולות - manual tasks, opportunities (manual + M5 engine) and M6
// decisions and M7 change tracking, as local tabs.
const TABS = [
  { id: "tasks", label: "משימות" },
  { id: "opportunities", label: "הזדמנויות" },
  { id: "decisions", label: "החלטות" },
  { id: "tracking", label: "מעקב שינויים" }
];

export default function BusinessActions() {
  const [tab, setTab] = useSubTab(TABS, "tasks");
  return (
    <div>
      <SubTabs tabs={TABS} current={tab} onSelect={setTab} label="פעולות" />
      <div className="subtab-panel" role="tabpanel">{tab === "tasks" ? <BusinessTasks /> : tab === "opportunities" ? <BusinessOpportunities /> : tab === "decisions" ? <BusinessDecisions /> : <BusinessTracking />}</div>
    </div>
  );
}
