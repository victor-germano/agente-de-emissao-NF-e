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

// Espelha o seed real do Supabase (ver README) para que o painel local funcione
// identicamente nos dois modos de persistencia. Excecao: pat_3 no Supabase tem duas
// consultas (troca de medico, doc_1 -> doc_3) para exercitar a regra "ultimo medico que
// atendeu o paciente" com historico de verdade - este repositorio in-memory nao modela
// historico de consultas, entao guarda direto o resultado final (doc_3) sem a
// demonstracao do "switch" em si, que so aparece rodando contra o Supabase real.
const SEED: SeedRecord[] = [
  {
    patient: { id: "pat_1", name: "Ana Souza", email: "ana.souza@example.com", cpf: "111.111.111-11" },
    doctor: { id: "doc_1", name: "Dr. Carlos Lima", crm: "CRM-SP 12345" },
  },
  {
    patient: { id: "pat_2", name: "Bruno Alves", email: "bruno.alves@example.com", cpf: "222.222.222-22" },
    doctor: { id: "doc_2", name: "Dra. Fernanda Rocha", crm: "CRM-SP 54321" },
  },
  {
    patient: { id: "pat_3", name: "Camila Ferreira", email: "camila.ferreira@example.com", cpf: "333.333.333-33" },
    doctor: { id: "doc_3", name: "Dr. Eduardo Santos", crm: "CRM-SP 33333" },
  },
  {
    patient: { id: "pat_4", name: "Diego Martins", email: "diego.martins@example.com", cpf: "444.444.444-44" },
    doctor: { id: "doc_4", name: "Dra. Juliana Mendes", crm: "CRM-SP 44444" },
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
