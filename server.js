import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Configurar CORS para permitir solicitudes desde el frontend
app.use(cors({
  origin: ['https://lab.va360.pro'],
  credentials: true
}));

// Ruta de prueba
app.get('/', (req, res) => {
  res.json({ status: 'API is running' });
});

// Middleware para el webhook de Stripe
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Error de firma del webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const affiliateId = session.client_reference_id;
    
    console.log('Evento checkout.session.completed recibido:', {
      affiliateId,
      amount: session.amount_total,
      customerEmail: session.customer_details.email,
      subscription: session.subscription
    });

    if (!affiliateId) {
      console.log('No hay ID de afiliado en la sesión');
      return res.json({ received: true, processed: false });
    }

    try {
      // Verificar si el afiliado existe
      const { data: affiliateData, error: affiliateError } = await supabase
        .from('affiliates')
        .select('id')
        .eq('id', affiliateId)
        .single();

      if (affiliateError || !affiliateData) {
        console.error('Afiliado no encontrado:', affiliateId);
        return res.status(400).json({ error: 'Afiliado no encontrado' });
      }

      console.log('Afiliado encontrado:', affiliateData);
      
      // Registrar la venta
      const { data: saleData, error: saleError } = await supabase
        .from('affiliate_sales')
        .insert([
          {
            affiliate_id: affiliateId,
            amount: session.amount_total / 100,
            customer_email: session.customer_details.email,
            sale_date: new Date().toISOString(),
            subscription_id: session.subscription,
            payment_status: session.payment_status
          }
        ])
        .select();

      if (saleError) {
        console.error('Error al registrar la venta:', saleError);
        throw saleError;
      }

      console.log('Venta registrada:', saleData);

      // Actualizar estadísticas
      const { data: statsData, error: statsError } = await supabase
        .rpc('update_affiliate_stats', {
          p_affiliate_id: affiliateId,
          p_amount: session.amount_total / 100
        });

      if (statsError) {
        console.error('Error al actualizar estadísticas:', statsError);
        throw statsError;
      }

      console.log('Estadísticas actualizadas:', statsData);
      
      return res.json({ received: true, processed: true });
    } catch (err) {
      console.error('Error al procesar la venta del afiliado:', err);
      return res.json({ received: true, error: err.message });
    }
  }

  res.json({ received: true });
});

app.listen(port, () => {
  console.log(`API Server running on port ${port}`);
});
