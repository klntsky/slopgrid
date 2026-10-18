import { useRef, useState } from "react";
import type { GridInput } from "../../server/domain";
import { DeletableInput } from "./deletable-input";
import { ReorderHandle } from "./reorder-handle";
import "./criteria-editor.css";

type Criteria = NonNullable<GridInput["judge"]>["criteria"];

export function CriteriaEditor({
  criteria,
  onChange,
}: {
  criteria: Criteria;
  onChange: (criteria: Criteria) => void;
}) {
  const root = useRef<HTMLTableElement>(null);
  const [dragging, setDragging] = useState<number>();
  const [dragTarget, setDragTarget] = useState<number>();

  function move(from: number, to: number) {
    if (to < 0 || to >= criteria.length || from === to) return;
    const next = [...criteria];
    next.splice(to, 0, ...next.splice(from, 1));
    onChange(next);
  }

  function dragChange(source?: number, target?: number) {
    setDragging(source);
    setDragTarget(target);
  }

  function update(index: number, change: Partial<Criteria[number]>) {
    onChange(
      criteria.map((criterion, position) =>
        position === index ? { ...criterion, ...change } : criterion,
      ),
    );
  }

  return (
    <div className="criteria-editor">
      <table className="criteria-table" ref={root}>
        <colgroup>
          <col className="criteria-handle-column" />
          <col />
          <col className="criteria-answer-column" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" aria-label="Move criterion" />
            <th scope="col">Criterion</th>
            <th scope="col">Correct answer</th>
          </tr>
        </thead>
        <tbody>
          {criteria.map((criterion, index) => (
            <tr
              className="criteria-row"
              data-dragging={dragging === index}
              data-insertion={
                dragTarget === index
                  ? "before"
                  : index === criteria.length - 1 &&
                      dragTarget === criteria.length
                    ? "after"
                    : undefined
              }
              key={index}
            >
              <td>
                <ReorderHandle
                  index={index}
                  label={`Move criterion ${index + 1}`}
                  root={root}
                  rowSelector=".criteria-row"
                  count={criteria.length}
                  onMove={move}
                  onDragChange={dragChange}
                />
              </td>
              <td>
                <DeletableInput
                  content={criterion.text}
                  label={`Remove criterion ${index + 1}`}
                  onRemove={() =>
                    onChange(
                      criteria.filter((_, position) => position !== index),
                    )
                  }
                >
                  <textarea
                    aria-label={`Criterion ${index + 1}`}
                    placeholder="a yes-or-no question about the output."
                    rows={1}
                    value={criterion.text}
                    onChange={(event) =>
                      update(index, { text: event.target.value })
                    }
                  />
                </DeletableInput>
              </td>
              <td>
                <select
                  aria-label="Correct answer"
                  value={String(criterion.correctAnswer)}
                  onChange={(event) =>
                    update(index, {
                      correctAnswer: event.target.value === "true",
                    })
                  }
                >
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        onClick={() =>
          onChange([...criteria, { text: "", correctAnswer: true }])
        }
      >
        Add criterion
      </button>
    </div>
  );
}
