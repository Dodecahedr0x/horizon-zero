export function createTaskQueue() {
  const tasks = [];
  let nextId = 1;

  function view(task) {
    const row = {
      id: task.id,
      node: task.node,
      kind: task.kind,
      status: task.status,
      error: task.error,
    };
    if (task.direction) row.direction = task.direction;
    return row;
  }

  function enqueue({ node, kind, work, direction }) {
    const guide = typeof direction === "string" ? direction.trim() : "";
    const task = {
      id: String(nextId++),
      node: String(node),
      kind,
      status: "queued",
      error: null,
      direction: guide,
      work,
    };
    tasks.push(task);
    // Each job starts on its own turn. Nothing waits for another job to finish.
    Promise.resolve()
      .then(() => {
        if (task.status !== "queued") return;
        task.status = "running";
        return task.work();
      })
      .then(() => {
        if (task.status === "running") task.status = "done";
      })
      .catch((error) => {
        task.status = "failed";
        task.error = (error instanceof Error ? error.message : String(error)).slice(-2000);
      });
    return view(task);
  }

  function list() {
    return tasks.map(view);
  }

  function clearFinished() {
    for (let index = tasks.length - 1; index >= 0; index -= 1) {
      if (tasks[index].status === "done" || tasks[index].status === "failed") tasks.splice(index, 1);
    }
    return list();
  }

  function fail({ node, kind, error }) {
    const task = {
      id: String(nextId++),
      node: String(node),
      kind,
      status: "failed",
      error: String(error).slice(-2000),
      direction: "",
      work: null,
    };
    tasks.push(task);
    return view(task);
  }

  return { enqueue, list, clearFinished, fail };
}
