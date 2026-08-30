import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main>Electron Agent</main>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
