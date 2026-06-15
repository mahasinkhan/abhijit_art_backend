// backend/models/User.ts
import mongoose, { Schema, InferSchemaType, type HydratedDocument } from "mongoose";

const userSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    phone: { type: String, default: "" },
    password: { type: String, required: true },
    role: { type: String, enum: ["client", "admin"], default: "client" },
  },
  { timestamps: true }
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export type UserHydrated = HydratedDocument<UserDoc>;
export default mongoose.model("User", userSchema);