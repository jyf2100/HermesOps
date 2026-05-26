import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom";
import { AdminLayout } from "./components/AdminLayout";
import { DashboardPage } from "./pages/DashboardPage";
import { AgentDetailPage } from "./pages/AgentDetailPage";
import { CreateAgentPage } from "./pages/CreateAgentPage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage } from "./pages/LoginPage";
import { ChatPage } from "./pages/ChatPage";
import { FileBrowserPage } from "./pages/FileBrowserPage";
import { TemplateListPage } from "./pages/TemplateListPage";
import { TaskDispatchPage } from "./pages/TaskDispatchPage";
import { MyTasksPage } from "./pages/MyTasksPage";
import { MonitoringPage } from "./pages/MonitoringPage";
import { setAdminKey, getAuthMode } from "./lib/admin-api";
import { useEffect } from "react";

function App() {
  useEffect(() => {
    const mode = getAuthMode();
    if (mode === "admin") {
      const key = localStorage.getItem("admin_api_key");
      if (key) setAdminKey(key);
    }
  }, []);

  return (
    <BrowserRouter basename="/admin">
      <Routes>
        <Route element={<AdminLayout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/monitoring" element={<MonitoringPage />} />
          <Route path="/agents/:id" element={<AgentDetailPage />} />
          <Route path="/create" element={<CreateAgentPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/files" element={<FileBrowserPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/templates" element={<TemplateListPage />} />
          <Route path="/dispatch" element={<TaskDispatchPage />} />
          <Route path="/my-tasks" element={<MyTasksPage />} />
        </Route>
        <Route path="/login" element={<LoginPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
