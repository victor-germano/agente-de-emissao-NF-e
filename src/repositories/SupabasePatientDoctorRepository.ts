import type { SupabaseClient } from "@supabase/supabase-js";
import type { PatientDoctorRepository } from "./PatientDoctorRepository.js";
import type { Doctor, Patient } from "../domain/models.js";

interface ConsultationRow {
  doctor_id: string;
  occurred_at: string;
  doctors: { id: string; name: string; crm: string } | null;
}

/**
 * Persistencia real (tabelas `patients`, `doctors`, `consultations`). O
 * "ultimo medico que atendeu o paciente" (etapa 3 do TO-BE) e resolvido via
 * a consulta mais recente em `consultations`, ordenada por `occurred_at`.
 */
export class SupabasePatientDoctorRepository implements PatientDoctorRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findPatientById(patientId: string): Promise<Patient | null> {
    const { data, error } = await this.client.from("patients").select().eq("id", patientId).maybeSingle();
    if (error) throw new Error(`Falha ao buscar paciente ${patientId} no Supabase: ${error.message}`);
    if (!data) return null;
    return { id: data.id, name: data.name, email: data.email, cpf: data.cpf };
  }

  async findLastDoctorForPatient(patientId: string): Promise<Doctor | null> {
    const { data, error } = await this.client
      .from("consultations")
      .select("doctor_id, occurred_at, doctors(id, name, crm)")
      .eq("patient_id", patientId)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle<ConsultationRow>();

    if (error) throw new Error(`Falha ao buscar medico do paciente ${patientId} no Supabase: ${error.message}`);
    if (!data?.doctors) return null;
    return { id: data.doctors.id, name: data.doctors.name, crm: data.doctors.crm };
  }
}
