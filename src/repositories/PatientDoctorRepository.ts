import type { Doctor, Patient } from "../domain/models.js";

export interface PatientDoctorRepository {
  findPatientById(patientId: string): Promise<Patient | null>;
  /**
   * Equivalente ao passo 4 do AS-IS ("busca na base de consultas do Notion
   * qual foi o ultimo medico que atendeu o paciente"), mas resolvido
   * instantaneamente a partir de dados que o proprio App VYX ja possui.
   */
  findLastDoctorForPatient(patientId: string): Promise<Doctor | null>;
}

interface SeedRecord {
  patient: Patient;
  doctor: Doctor;
}

const SEED: SeedRecord[] = [
  {
    patient: { id: "pat_1", name: "Ana Souza", email: "ana.souza@example.com", cpf: "111.111.111-11" },
    doctor: { id: "doc_1", name: "Dr. Carlos Lima", crm: "CRM-SP 12345" },
  },
  {
    patient: { id: "pat_2", name: "Bruno Alves", email: "bruno.alves@example.com", cpf: "222.222.222-22" },
    doctor: { id: "doc_2", name: "Dra. Fernanda Rocha", crm: "CRM-SP 54321" },
  },
];

/**
 * Implementacao in-memory para o prototipo/testes. Em producao seria
 * substituida por um SupabaseRepository lendo as tabelas patients/doctors/
 * consultations (ver README, secao "Como plugar integracoes reais").
 */
export class InMemoryPatientDoctorRepository implements PatientDoctorRepository {
  private readonly byPatientId = new Map<string, SeedRecord>();

  constructor(seed: SeedRecord[] = SEED) {
    for (const record of seed) {
      this.byPatientId.set(record.patient.id, record);
    }
  }

  async findPatientById(patientId: string): Promise<Patient | null> {
    return this.byPatientId.get(patientId)?.patient ?? null;
  }

  async findLastDoctorForPatient(patientId: string): Promise<Doctor | null> {
    return this.byPatientId.get(patientId)?.doctor ?? null;
  }
}
