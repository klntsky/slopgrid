import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
export function CreateGridButton() {
  return (
    <Link to="/" className="button primary create-grid-button">
      <Plus aria-hidden="true" />
      NEW GRID
    </Link>
  );
}
