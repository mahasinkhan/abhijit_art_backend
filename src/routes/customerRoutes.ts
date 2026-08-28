// backend/src/routes/customerRoutes.ts
import { Router } from "express";
import { protect, adminOnly } from "../middleware/auth.js";
import * as customer from "../controllers/customer.controller.js";

const router = Router();

router.use(protect, adminOnly);

router.get   ("/",           customer.listCustomers);
router.post  ("/",           customer.createCustomer);
router.post  ("/email",      customer.emailCustomers);
router.get   ("/:id",        customer.getCustomer);
router.patch ("/:id",        customer.updateCustomer);
router.delete("/:id",        customer.deleteCustomer);

export default router;