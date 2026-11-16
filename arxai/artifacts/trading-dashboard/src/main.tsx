import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installErrorCapture } from "./assistant/errorBuffer";
import { installViewModeFetchShim } from "./lib/viewMode/fetchShim";

installErrorCapture();
installViewModeFetchShim();
createRoot(document.getElementById("root")!).render(<App />);
