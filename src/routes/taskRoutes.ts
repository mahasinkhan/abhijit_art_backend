// backend/src/routes/taskRoutes.ts
import { Router } from "express";
import { protect, adminOnly } from "../middleware/auth.js";
import { taskUpload } from "../middleware/upload.js";
import { taskController } from "../controllers/task.controller.js";
import { employeeController } from "../controllers/employee.controller.js";

const router = Router();
router.use(protect);

// ── Static routes first ──────────────────────────────────────────────────────
router.get("/mine",           taskController.getMine);
router.get("/team",           taskController.getTeam);
router.get("/employees/list", adminOnly, employeeController.list);

// ── Task CRUD ────────────────────────────────────────────────────────────────
router.post("/",    adminOnly, taskUpload.array("images", 10),    taskController.create);
router.get("/",     adminOnly,                                     taskController.getAll);
router.get("/:id",                                                 taskController.getOne);
router.patch("/:id",adminOnly, taskUpload.array("newImages", 10), taskController.update);
router.patch("/:id/status",                                        taskController.updateStatus);
router.patch("/:id/deliver",                                       taskController.deliver);
router.delete("/:id", adminOnly,                                   taskController.remove);

export default router;